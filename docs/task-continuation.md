# Continue the same task on another harness

A usage or token limit is a failed turn, not a reason to recreate the task. **Retry** and ordinary messages keep its saved harness. **Continue with…**, available on the failure banner and in a resting task's details, explicitly chooses Claude Code, Codex, Cursor, OpenCode, or the current project/Settings default.

The task id, runner, branch/PR, workspace, uncommitted work, archive, attachments, transcript and queued messages stay with the task. A different harness gets a new CLI session id and a bounded recap (original instructions, summary, branch/PR and recent conversation). It never resumes the other CLI's session. Earlier sessions remain in the workspace/archive for recovery. Switching back also starts a fresh session.

Changing the project's Agent or Settings' default affects **new tasks only**. Existing tasks never migrate automatically. Selecting **Current project / Settings default** explicitly resolves that default once for this task and clears its model/effort/routing pins. A harness change also clears all old pins. Unspecified model and effort then use that harness's defaults and the normal routing precedence, read on subsequent turns. Choosing the same explicit harness retains pins. This action never changes the runner or another task.

## API and manager tools

`POST /api/tasks/:id/continue` accepts `{agent?, model?, effort?, message?}`. The Captain and Coordinator use `continue_task` with those fields and `task`. For example:

```json
{"task":"task_example123", "agent":"codex", "message":"Continue from the existing workspace after the usage limit."}
```

`agent` may be `claude`, `codex`, `cursor`, `opencode` or `default`; omission keeps the saved harness. `model` and `effort` optionally pin compatible choices for later turns; `null` clears a pin. Known incompatible models are rejected rather than silently retained. Cursor carries effort in its model id. Chat harness picks do not implicitly switch a task: managers pass `agent` explicitly to `continue_task`. `send_to_task` remains the message/steering tool and must not recommend replacement tasks for harness limits.

Continuation accepts idle, failed and PR-ready tasks only. Stop a busy task and wait for its turn and workspace saving to finish. Capability and credential checks use the selected harness and existing runner before changing anything; availability is checked again after asynchronous checks. Changes and the continuation input are transactional. Existing queued inputs remain in order. A failed launch keeps them queued for retry. Workspace operations in progress return a conflict. Scope checks still limit Captains to their project; a status-only project's tool response contains only its permitted task brief.

If another harness needs a missing workspace, its existing archive must restore successfully. A failed restore preserves the archive, handoff and queue; this continuation refuses the ordinary fallback to a fresh checkout that could omit unpushed work. Recover the workspace or fix the restore failure before retrying. Credentials and CLI-specific environment selection use the normal per-turn path; no credential is copied from a recap or CLI session.

## Why replacement tasks lost access to earlier work

Previously, the task row persisted `agent_cli`, model and effort, but neither retry nor send exposed a harness change. Retry queued a message on that saved CLI. Manager prompts and harness-pick notes explicitly called the harness permanent and directed managers to create new tasks. This was both a missing control path and a tool/prompt policy restriction; recreating tasks was a workaround, not a requirement imposed by archives or Git.

Archives and hidden WIP refs belong to a **task id**. A replacement gets a new workspace, branch and `refs/boxyard/wip/<new-id>`; related-task text does not transfer the predecessor's archive or work. A whole archive can preserve work even when origin refused a push. Changing the default could not repair this because it only selected the CLI for newly created tasks.

For already-created replacements, an authorized operator can copy the predecessor's archive from the server's data directory into an isolated recovery folder without running or changing the stopped original. Inspect the copy first with `tar tzf`; do not unpack over a live workspace. Archives are normally `archives/<task-id>.tgz`; failed-restore fallbacks can leave `<task-id>.unrestored.tgz`. A whole archive carries `<task-id>/work/`; partial archives carry `.git` and a WIP snapshot (`refs/boxyard/wip`); thin archives carry `git-thin/` with HEAD/refs, index and unpushed bundle; git-first archives carry `git.manifest`/`git.pack` and may require the original task's branch and `refs/boxyard/wip/<original-id>` from origin. Shared-object clones can also need the archived `git-keep.pack` and relinking logic in `server/gitShare.ts`. Use the restore implementations in `server/archive.ts` and `server/gitFirst.ts` for those formats, preserving staged/unstaged state. Never rename or delete original refs/archives. There is no existing manager MCP archive-export/mount tool; replacement agents cannot retrieve server-local archives by naming a related task.

[OpenCode](opencode.md) continuation requires version 1.19.5 and API logins, uses provider/model#variant, and accepts no generic effort. Its native session state moves with the workspace archives.
