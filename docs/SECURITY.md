# 安全边界 / Security boundaries

- **受信任的本地客户端。** 任何能调用 MCP 工具的客户端都能在白名单内请求读取工作。只配置你愿意提供给 DSH 任务的项目。不要暴露给不受信任的网络或客户端。
- **写入额外授权。** 写模式开关、`allow_write: true`、精确目录及身份和有效的本地签名授权缺一不可。批准脚本与桥必须运行在受信任的本机账户下。能以同一用户访问授权密钥的进程不在此保护范围内。
- **实际执行边界由 DSH 决定。** 桥传递 DSH 的 read-only 或 workspace-write 模式，不提供 danger-full-access。提示词禁止发布、推送、读取凭据等操作，但不是命令防火墙。不要把含凭据的项目交给代理。
- **数据流。** 任务与上下文经 DSH 使用其配置的模型服务。模型输出、项目路径和日志摘要可能返回客户端；DSH 可以写自己的会话日志。桥对常见凭据形状作尽力脱敏，不保证覆盖所有敏感信息。
- **凭据与调试。** 不要提交真实配置、授权文件、DSH 目录或客户端日志。提交 Issue 前请删掉账号信息、访问地址、任务内容和私有路径。

Use only trusted local clients and narrow project directories. The bridge supplies DSH permission flags and verifies local write grants; DSH supplies the execution sandbox. Task data may reach the configured model provider and appear in DSH session logs. The bridge's redaction is best effort.

For a security report, use GitHub's private vulnerability reporting where available. Avoid publishing credentials or exploit details in a public issue.
