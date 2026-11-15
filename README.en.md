# ChatGPT–DSH Bridge

[中文 README](README.md) · [Releases](https://github.com/sho777564/chatgpt-dsh-bridge/releases) · MIT

A Windows MCP bridge that lets ChatGPT or Codex **plan and review** while DeepSeek Harness **runs the work**. Start a local coding task, poll progress, retrieve the result, or cancel it. Tasks are read-only by default and restricted to explicitly configured directories. Writes require a grant issued locally for that exact directory.

This is an independent project, unaffiliated with OpenAI or DeepSeek.

## Quick start

Use Windows 11, Node.js 22 or 24 LTS (20 minimum), an installed DeepSeek Harness with a working headless profile, and a client that supports local STDIO MCP.

```powershell
git clone https://github.com/sho777564/chatgpt-dsh-bridge.git
cd chatgpt-dsh-bridge
$project = (Resolve-Path 'C:\Projects\my-app').Path # Replace with your project
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -AllowedRoots $project
```

Reload your client's local plugins, select **ChatGPT–DSH Bridge**, and call `dsh_health_check`. Once it responds, ask DSH to inspect your project's test setup in read-only mode. For other clients, see [manual STDIO configuration](docs/COMPATIBILITY.md). Web and mobile clients do not launch this Windows process.

To allow writes, add `-EnableWriteMode` during installation, then issue a [local grant](docs/WRITE-AUTH.md). Keep write grants short unless you need them across restarts. An empty allowlist allows health checks only.

```powershell
npm ci
npm test      # Offline tests, including MCP and grant verification
npm run smoke # Check your real CLI and profile without calling a model
```

For a live read-only task, copy [the example config](bridge.config.example.json) to `bridge.config.json`, set your allowlist, then run `npm run smoke -- --workspace "$project"`. This uses the DeepSeek service.

See [security boundaries](docs/SECURITY.md) before connecting a client. Issues and pull requests are welcome. If the bridge helps you, consider starring the repo.
