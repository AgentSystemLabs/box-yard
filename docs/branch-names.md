# Task branch names

New task branches follow the repository's own convention. Before creating the task branch, Box Yard reads the fresh clone's remote branch refs, recent merged PR head refs with `gh pr list`, and branch guidance in `CONTRIBUTING`, `CONTRIBUTING.md`, `AGENTS.md`, `CLAUDE.md` and Markdown files under `.github` on the project's base branch. The clone uses the shared mirror when available. The same server path prepares Upstash, local, Docker, SSH and GPU workspaces.

Branch-specific documented examples and casing rules take precedence. Otherwise, repeated recent merged names take precedence over older remote branches. A pattern needs at least two distinct examples and 60% support; when a repo uses change-type prefixes, matching examples select `feature/`, `feat/`, `task/`, `fix/`, `bug/`, `chore/` and similar prefixes for the task. Tool-generated names and asset/release/base branches aren't convention evidence. Mixed or insufficient evidence falls back to a plain descriptive slug.

The inferred pattern preserves separators and casing, and puts an issue, ticket or story reference from the task title/prompt in the observed position, such as `ABC-123-description`, `123-description`, `issue-123-description` or `description-123`. It retains the task's ticket key and never invents a ticket number from another branch. Without a ticket-placement pattern, an explicit reference goes before the slug. Without a ticket, it uses the descriptive part. A short random suffix is added only if the name conflicts with an existing remote branch, merged PR head, or task in the same repository, including tasks in another project. Git's branch/directory conflicts are checked too.

Examples:

| Repository evidence | New task | New branch |
| --- | --- | --- |
| No clear convention; legacy tool-prefixed branches only | Improve search | `improve-search` |
| `feature/first-change`, `feature/second-change` | Add search | `feature/add-search` |
| `fix/ABC-12-old-menu`, `fix/ABC-13-old-search` | Fix ABC-42 login | `fix/ABC-42-login` |
| `firstChange`, `secondChange` | Add search | `addSearch` |
| `old-menu-12`, `old-search-13` | Fix story 42 login | `fix-login-42` |

`gh` being unavailable or timing out only removes that evidence source. No naming step changes a runner or an authentication setting. Each `gh`/Git evidence subprocess has a ten-second timeout and bounded output; only the first twenty matching documentation files (16 KB each) are read. Guidance is parsed as text and never executed.

New tasks initially reserve a plain name in the database, then resolve the convention once before creating a Git branch. The reservation and the pending naming marker are written together; the resolved name and removal of that marker are also atomic. Retries, archives, missing-workspace recaps and older tasks retain their recorded branch. Agents are given the same naming rule for follow-up branches after a PR merges.

Existing branches are never renamed, including legacy `boxyard/*` branches. Restore, push, detection and cleanup still accept their complete recorded names. Hidden `refs/boxyard/wip/<task>` recovery refs, archive snapshot refs, box paths and the PR artifact branch are separate mechanisms and retain their names.
