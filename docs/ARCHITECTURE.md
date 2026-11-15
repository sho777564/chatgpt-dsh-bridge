# 架构

```text
ChatGPT Desktop / MCP Client
        |
        | MCP JSON-RPC over stdio
        v
server/index.js  (McpServer + StdioServerTransport)
        |
        +-- tools.js
        |     dsh_health_check
        |     dsh_start_task
        |     dsh_get_status
        |     dsh_get_result
        |     dsh_cancel_task
        |     dsh_list_tasks
        |
        +-- TaskManager  (in-memory tasks, bounded waits, terminal states)
        |     |
        |     +-- DshRunner
        |           build clean env
        |           spawn(DeepSeek Harness.exe, args, shell:false)
        |           stdin <- task
        |           stdout -> NDJSON events
        |           stderr -> redacted diagnostics
        |
        +-- PathPolicy     (absolute path, realpath, sensitive dirs, allowedRoots)
        +-- Policy         (read-only/workspace-write, allow_write, local HMAC grant)
        +-- Config/Logger  (bridge.config.json, stderr-only logs)
```

## 为什么直接启动 Electron 而不是 dsh.cmd

DSH 安装目录中的 `dsh.cmd` 实际做的是：

```bat
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\..\..\DeepSeek Harness.exe" --expose-internals ^
  "%~dp0..\..\..\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*
```

在 Node 中通过 `spawn("dsh.cmd", ...)` 且 `shell:false` 不可靠，而 `cmd.exe /c` 会引入 shell 解析。桥直接从 `dsh.cmd` 的位置推导 app 根目录，然后：

```js
spawn("G:\\...\\DeepSeek Harness.exe", [
  "--expose-internals",
  "G:\\...\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js",
  "--profile", "headless",
  "--json",
  "--permission-mode", "read-only",
  "--approval-policy", "never",
  "-"
], { shell: false, cwd: workspace, env: { ELECTRON_RUN_AS_NODE: "1", ... } });
```

任务正文从 stdin 写入，避免命令行长参数/转义问题。

## 状态机

```text
start -> running
running -> completed     exit 0 + final event
running -> failed        non-zero exit / spawn error / missing final
running -> timed_out     timeout timer -> taskkill /T /F -> close
running -> cancelled     user cancel -> taskkill /T /F -> close
```

`dsh_get_status` / `dsh_get_result` 的 `wait_seconds` 在服务端做有界长轮询（最大 25 秒），避免 ChatGPT 侧高频轮询。工具说明要求最多连续 6 次。

## 内存边界

任务只保存在 MCP server 进程中；最多 20 个，超出先清理最旧的终态任务。服务重启后旧 task id 不可查。这是有意的简化：不持久化凭据/任务内容，也不在磁盘上留下额外任务日志。

## 数据边界

- 任务文本：在内存和 DSH 子进程 stdin 中；可能被 DSH 写入它自己的 session 日志（这是 DSH 的行为）。
- 最终结果：内存 + 返回给 MCP 客户端；不另写桥日志。
- DSH stderr：只保留最多 80 行、每行 1,000 字符，默认不返回；`include_logs=true` 才返回尾部。
- 凭据：从不读取内容。
