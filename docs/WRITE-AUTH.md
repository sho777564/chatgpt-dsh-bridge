# 写入授权 / Workspace write grants

1. 在实际运行的实例配置里设置 `allowedRoots`（绝对项目目录）和 `writeModeEnabled: true`，重启该实例。已经通过安装脚本设置可以跳过此步。
2. 从该实例的安装或源码目录运行下面的命令，把目录替换成项目的真实绝对路径。在交互提示中选择是否批准。
3. 客户端请求 `workspace-write` 并设置 `allow_write: true`。仍需对当前会话里的任务范围明确授权。

Set your allowlist and `writeModeEnabled` in the config loaded by your MCP process. From that installation or source directory, issue a timed grant locally, then pass both `workspace-write` and `allow_write: true` in the tool request.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\approve-write.ps1 -Workspace 'C:\Projects\my-app' -Minutes 30
node .\scripts\write-grant-status.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\revoke-write.ps1
```

- 临时授权有效期为 1–240 分钟。使用 `-Permanent` 必须在交互式终端输入 `PERMANENT`。永久授权不会自动过期。
- 只有一份当前授权。重新签发会替换它。目录身份不匹配或撤销会阻止新任务；已经运行的任务需要另行取消。
- 源码版、安装版或其它客户端可能加载不同配置。若使用 `DSH_BRIDGE_CONFIG`，签发和撤销时也指向同一文件，可指定 `-ConfigPath`。
- v0.3.0 起空白名单不再允许派发任务。升级时保留自己的项目路径，并确认实际运行实例使用对应配置。
