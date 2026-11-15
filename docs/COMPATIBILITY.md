# 客户端接入 / Client setup

这个项目提供 Windows 本地 STDIO MCP 进程，不需要开监听端口。客户端必须能够启动本机进程。仅看到插件名称不能证明该客户端能调用工具；先验证 `dsh_health_check` 的实际返回。

The server runs on Windows and speaks MCP over STDIO. Use a client that can launch a local process, and verify by actually calling `dsh_health_check`.

## 本地插件 / Local plugin

`scripts/install.ps1` 注册个人 marketplace。安装目标默认为 `$HOME\.codex\plugins\chatgpt-dsh-bridge`。重启或重新加载客户端，再从本地 marketplace 选择该插件。具备本地 Tool 能力的 ChatGPT Work 或 Codex 会话才可尝试调用。

## 手动注册 / Manual registration

在源码目录运行 `npm ci`，复制 `bridge.config.example.json` 为 `bridge.config.json`，填入自己的绝对项目路径。下面是 STDIO 配置示例，请替换 Node 和仓库的绝对路径，并根据客户端支持的格式调整：

```json
{
  "mcpServers": {
    "dsh_bridge": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\Tools\\chatgpt-dsh-bridge\\server\\index.js"],
      "env": {
        "DSH_BRIDGE_CONFIG": "C:\\Tools\\chatgpt-dsh-bridge\\bridge.config.json"
      }
    }
  }
}
```

No DSH CLI found? Set `dshCliPath` to the full path of `resources\runtime\cli\bin\dsh.cmd` in your DSH install, then restart the MCP process. The bridge does not install or log in to DeepSeek Harness.
