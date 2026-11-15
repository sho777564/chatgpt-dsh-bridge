---
name: chatgpt-dsh-bridge
description: Use when the user wants ChatGPT to plan or review work while DeepSeek Harness (DSH) executes coding tasks locally. Covers AUTO, GPT_ONLY, and DSH_REQUIRED modes, safe task dispatch, status polling, result review, and cancel behavior. Do not use for ordinary conversation or when the user has not asked for local execution.
---

# ChatGPT–DSH Bridge

This plugin lets ChatGPT act as the planning and review layer while a local
DeepSeek Harness (DSH) headless process performs file operations, coding,
tests, and fixes. ChatGPT never gets a shell; it only calls the DSH bridge MCP
tools.

## First rule: mode selection

Determine the working mode from the user's current instruction, not from a
hidden global setting. The bridge cannot control ChatGPT's model picker.

| Mode | Behavior |
| --- | --- |
| `AUTO` (default) | Answer normally. Call DSH only when local execution is actually necessary. If the request is ambiguous or would modify files, ask first. |
| `GPT_ONLY` | Never call any `dsh_*` tool. Answer entirely in ChatGPT. |
| `DSH_REQUIRED` | Plan the task, dispatch it with `dsh_start_task`, wait, retrieve the result, and review it. Still respect read-only and write approval rules. |

If the user says "use DSH" or "let DSH do it", use `DSH_REQUIRED`. If they ask a
conceptual question, use `GPT_ONLY` for that turn. If they ask for a code
change, default to `AUTO` and ask for the workspace path and write approval
before creating a write task.

## Scope and truthfulness

- Do not claim that a local plugin or MCP tool is available in ordinary ChatGPT
  Chat. Local tool exposure is controlled by the host. Only report success
  after a real tool call has returned.
- The bridge has no access to ChatGPT cookies, browser sessions, OpenAI API
  keys, or DeepSeek credentials. Never ask it to read them.
- Never expose the local write approval secret or ask for a write token. There is
  no token in the tool schema. The user approves locally with
  `scripts\approve-write.ps1`; a timed grant expires, while a permanent grant is
  scoped to one exact directory identity and lasts until revoked. Only the local
  user can issue a permanent grant in an interactive terminal.
- Do not use DSH for text-only answers, brainstorming, or work ChatGPT can do
  without touching local files.

## Standard workflow

1. Call `dsh_health_check` before the first task in a conversation. Use
   `probe=true` only when the user wants a live model-connection test; it makes
   a small real DSH call.
2. Ask for an absolute workspace path if the user did not provide one. It must
   be inside a project directory in the local bridge allowlist.
3. Start with `permission_mode: "read-only"` unless the user explicitly asked
   for changes.
4. For writes, first present the plan and the exact workspace, then ask the
   user to approve locally. The model cannot create the approval; only the
   local user can. After the user confirms they ran `scripts\approve-write.ps1`,
   call `dsh_start_task` with `permission_mode: "workspace-write"` and
   `allow_write: true`. For a long-lived project the user may choose the
   interactive `-Permanent` approval; never suggest `-Permanent -Yes`. Do not
   ask for, accept, echo, or store a token. If the tool returns
   `WRITE_LOCAL_APPROVAL_REQUIRED`, relay the local command and wait; do not
   retry in a loop.
5. Keep `timeout_seconds` reasonable (default 600, maximum 1800). The bridge
   kills the process tree on timeout.
6. Poll with `dsh_get_status` or `dsh_get_result` and `wait_seconds: 20`.
   Do not make more than six consecutive wait calls without reporting progress
   to the user. Never poll in a tight loop.
7. When the task is terminal, call `dsh_get_result`, report the actual result,
   the test summary, and any errors. If tests did not run, say so.
8. If the user asks to stop, call `dsh_cancel_task`.

## Task wording

Give DSH a concrete, bounded task:

- Repository/project path and scope.
- What to inspect or change.
- Acceptance criteria and the exact tests to run.
- Constraints: "do not git push", "do not deploy", "do not modify files outside
  this workspace", "do not read credentials".
- A request to report commands, test results, and remaining risks.

## Result review

After `dsh_get_result`:

- Treat `result.tests` as a heuristic extraction, not proof. Read
  `result.text` and verify the claimed commands/results.
- A `completed` status means DSH's process completed, not that the user's
  request is correct. Review the diff or evidence when available.
- A `failed`, `cancelled`, or `timed_out` status must be reported as such.
- Do not invent file changes, test passes, or commit hashes.

## Safety boundaries

Read-only is the default. Workspace-write requires a valid local write grant plus
`allow_write: true`. The bridge blocks drive roots, system/credential directories,
and its own plugin directory, and it disables `danger-full-access`. It also adds a
policy preamble to every DSH task. That preamble is not a hard shell firewall;
the strongest guarantee is read-only mode, so prefer it.

Never use DSH to run git push, deploy, publish, release, delete a project, read
credentials or browser data, or exfiltrate files. If a task needs any of these,
stop and ask the user to do it outside DSH.
