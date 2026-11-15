# Changelog

## 0.3.0

- Require a configured project allowlist for tasks, including read-only tasks. Reject workspaces overlapping bridge or credential locations.
- Pick up a newly issued local grant without restarting the bridge.
- Preserve UTF-8 across output chunks, discard oversized records, and bound the metadata exposed to MCP clients.
- Check the staged plugin before replacing an existing installation and retain an upgrade backup.
- Run unit and MCP integration tests without an installed DSH or model account. Make the live smoke task opt-in.
- Publish bilingual quick starts and generic configurations under the existing MIT license.
