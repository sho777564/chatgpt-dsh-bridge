# ChatGPT–DSH Bridge

[English](README.en.md) · [版本发布](https://github.com/sho777564/chatgpt-dsh-bridge/releases) · MIT

[![CI](https://github.com/sho777564/chatgpt-dsh-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/sho777564/chatgpt-dsh-bridge/actions/workflows/ci.yml)

让 ChatGPT 或 Codex 负责规划和审查，让 Windows 上的 **DeepSeek Harness** 执行代码任务。通过本地 MCP 启动任务、查看进度、取回结果或取消。适合想把「让一个模型执行，另一个模型复核」用在日常开发中的人。

**默认只读，限定目录。** 每个任务必须指向你列入白名单的项目；写入还需要你在本地签发授权。项目是独立的开源桥接工具，与 OpenAI 或 DeepSeek 无隶属关系。

## 5 分钟上手

需要 Windows 11、Node.js 22 或 24 LTS（最低 20）、已安装并可使用 headless profile 的 DeepSeek Harness，以及支持本地 STDIO MCP 的客户端。

```powershell
git clone https://github.com/sho777564/chatgpt-dsh-bridge.git
cd chatgpt-dsh-bridge
$project = (Resolve-Path 'C:\Projects\my-app').Path # 换成实际项目目录
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -AllowedRoots $project
```

脚本安装依赖、验证 MCP 工具和 DSH CLI，并注册本地 marketplace。重新加载客户端并选择 **ChatGPT–DSH Bridge**，先调用 `dsh_health_check`。能收到工具响应后，试一下：

> 用 DSH 以只读模式检查 `C:\Projects\my-app` 的测试入口。列出建议运行的命令，并说明哪些命令实际执行过。

找不到 DSH 时，用 `-DshCliPath` 指定安装目录里的 `resources\runtime\cli\bin\dsh.cmd`。其他 MCP 客户端可以用 [手动接入方式](docs/COMPATIBILITY.md)。普通 Chat、网页和移动客户端是否能访问本地工具取决于宿主。

## 授权写入

先审查任务计划。安装时可加 `-EnableWriteMode`，也可以在 **实际启动的桥接实例** 配置中设为 `writeModeEnabled: true` 后重启。然后在本地 PowerShell 授权指定目录：

```powershell
$bridge = Join-Path $HOME '.codex\plugins\chatgpt-dsh-bridge'
powershell -NoProfile -ExecutionPolicy Bypass -File "$bridge\scripts\approve-write.ps1" -Workspace $project -Minutes 30
```

有任务需要改动时，客户端传 `permission_mode: "workspace-write"` 和 `allow_write: true`。授权只匹配这一目录，签名密钥保留在本机。撤销、永久授权和配置迁移见 [写入授权](docs/WRITE-AUTH.md)。

## 开发与验证

```powershell
npm ci
npm test
npm run smoke                            # 实际 CLI 和 profile，无模型调用
npm run smoke -- --workspace "$project"  # 实际只读任务，会使用 DeepSeek 服务
```

从源码运行任务时，先复制 [配置示例](bridge.config.example.json) 为 `bridge.config.json`，并填写你自己的白名单。空白名单仅允许健康检查。默认测试使用模拟 DSH，通过真实 MCP STDIO 验证工具、任务流程和授权，不需要账号。详见 [架构](docs/ARCHITECTURE.md) 和 [安全边界](docs/SECURITY.md)。

欢迎提带复现步骤的 Issue 和 PR。觉得这个流程有用，欢迎点右上角 **⭐ Star**，也欢迎分享给在用 DeepSeek Harness 的朋友。
