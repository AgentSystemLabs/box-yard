# Compaction history

Coordinator, Captain and task agents get progressive access to **retained Box Yard compactions**. Their initial system context includes five recent dated entries with content-derived topics and descriptions, the total count, earliest/latest save times, and a cursor to every older entry. It does not load every full compaction into context. The existing latest-summary recovery after a chat session resets remains, subject to the privacy guard below.

## Browse, summarize, read

For the Coordinator's own archive, or a Captain's own archive when called by that Captain:

```json
{"tool":"compaction_history","arguments":{"limit":10,"since":"2026-10-01","until":"2026-10-31T23:59:59Z"}}
```

The response has `total` (all retained entries in the authorized collection), `matched` (entries in the inclusive date window), `coverage` (UTC oldest/newest save times), `entries`, and `nextBefore`. Pass `nextBefore` as `before` to continue, retaining the same date filters. Pages default to 10 and cap at 20; the initial context uses five. `before` also accepts an exclusive ISO date/time. Times need a timezone; a date alone means midnight UTC. A removed cursor returns an error; restart with dates instead of silently skipping same-time entries.

Choose one entry's `id`, then progressively read it:

```json
{"tool":"read_compaction","arguments":{"compaction":"2026-10-20T10-00-00.000Z","level":"summary"}}
{"tool":"read_compaction","arguments":{"compaction":"2026-10-20T10-00-00.000Z","level":"full"}}
```

`summary` is an explicitly extractive excerpt with `extractive: true`, capped at 2,400 characters. `sampleLimited` identifies entries whose source exceeded the extraction sample. It samples a few actual lines across sections, prioritizes ongoing work for the title, and never invents events or calls another model. Index titles cap at 90 characters and descriptions at 200. Empty records say that no saved narrative is available.

`full` returns original saved text as `markdown`, with `offset`, `nextOffset`, `total`, and `offsetUnit`. Pass `nextOffset` verbatim until it is null. File reads use UTF-8 byte offsets and at most 16,000 bytes per chunk; requests smaller than a Unicode character may return that complete character (up to four bytes). SQLite reads use Unicode character offsets and at most 16,000 characters. Do not calculate offsets from JavaScript string length. Original text is never replaced by the excerpts.

The Coordinator can add `project` (a project id/name) to browse/read that Captain's archive, or `task` (a task id/title) to browse/read that task's own recaps. A Captain can select only its own project and its own project's tasks. Repeat the same selector when reading an id: references are stable **within their collection**, not globally unique across Captains. Task agents' tools have no project/task selectors and always refer to their own task.

Dates describe **save times**, not inferred covered ranges. Equal timestamps use a numeric collision suffix, then the stable id, to break ties. Paging includes every retained same-time entry without duplication or omissions. The index imposes no history-age cutoff.

## Sources and compatible access

| Agent/history | Original source | Scope and limitations |
| --- | --- | --- |
| Coordinator | `orchestrator/compactions/*.md` plus `orchestrator_compactions` in SQLite | Union by id; the DB copy wins when both exist. Includes older files never imported into SQLite, and DB copies whose files were lost. |
| Captain | `captains/<projectId>/compactions/*.md` | Project-scoped files, including old summaries without JSON sidecars. |
| Task | `task_compactions.summary` in SQLite | The existing Box Yard task recap, recorded by an explicit supported compaction; usually capped at 1,200 characters by the existing saver. This is not the provider's private internal compaction text. |

Coordinator and Captain compactions use the same catalog on Claude and Codex: the existing pre-compaction summary is saved before Claude `/compact`, or before Codex starts its next session. Tasks on Claude, Codex and Cursor get the same tools and own-task index. Native provider auto-compactions are **not exported as task history** by the existing runner. Codex/Cursor do not offer Box Yard's headless `/compact`; this change cannot recover internal summaries that were never saved. Existing retained task records are still available regardless of the harness selected now.

`search_history` remains a keyword search over saved summaries, chats and task history; it is still a scan on explicit request, not an automatic per-turn scan. `list_compactions` retains its legacy digest-array shape and linked-task filter; its old timestamp-only pagination remains for compatibility. Use `compaction_history` for complete date navigation and collision-safe paging. `find_compactions_by_task` retains linked-manager-compaction lookup. Its task recaps can now be opened individually with `read_compaction {task, compaction, level}`.

Omitting `level` on manager `read_compaction` keeps the legacy markdown/snapshot response, now bounded: 16,000 markdown characters and 20 snapshots. Follow `nextTasksOffset` using `tasks_offset` for more snapshots; snapshot summary text has 4,000-character chunks with `summaryNextOffset`/`summary_offset`. Use `level=full` for complete saved Markdown. Small existing reads keep their fields. Legacy Coordinator reads can also open a file-only search hit.

Task agents request a page or a read through their existing event channel. The server polls it, fixes the collection to the event's task, validates the current turn and request schema, then writes a bounded response into that task's directory. The runner waits up to 60 seconds and removes the response after reading it. Local, SSH and hosted runners use this same path; no worker-to-server socket or new credentials are needed. The normal poll interval and provider file-write latency affect response time. A timeout is retryable.

## Cache and backfill

The append-only migration adds a disposable SQLite `compaction_index` cache; it does not rewrite or delete original compactions. Discovery scans file names/stats and DB metadata. Previously unseen files get a bounded 1 KiB header read to recover legacy dates. Only entries on the requested page get content extraction: at most 32 KiB per file, or 32,768 Unicode characters from a DB record. Further detail stays available through full reads.

File timestamps come from saved frontmatter, then a recognized timestamp filename, then file modification time as a labeled legacy fallback. Non-timestamp names, spaces, old second-precision timestamps, missing sidecars and CRLF text are supported. Symlinks, directories and path references are rejected. Removed sources leave the catalog at the next discovery. A surviving Coordinator DB copy remains readable when its file is gone.

Excerpts persist across server restarts. File size/mtime/ctime and an extractor version invalidate file cache entries; DB insert/update triggers invalidate excerpts, including same-length corrections and replacement rows. New entries appear on the next context build or tool call. No model call or eager reread of all original text is added per turn. Removing only the cache causes compatible lazy backfill.

Discovery is **O(N) metadata work** per collection, including warmed calls; it is not a constant-time directory watcher. Counts/date selection/paging use the composite SQLite index. Content work is limited to the selected page, apart from the one-time bounded headers for newly discovered files. SQLite may scan the selected text to compute its Unicode length or locate a later substring. The compatibility full-record readers and explicit keyword search retain their existing larger disk-read costs; the progressive path avoids them.

A fixture with 500 retained entries (~28 MB of originals) measured on the local runner:

```text
initial context:           1,681 characters (five entries + coverage/navigation)
20-entry page:             4,704 characters
cold discovery/context:      19 ms
cached context rebuild:       3 ms
cached content reads:         0
cold file-read budget:   500 * 1,024 + 5 * 32,768 = 675,840 bytes
```

The fixture asserts page/context caps, cold read-size limits, zero warm content reads, and cache reuse after a new catalog instance. A separate test reopens the SQLite database to verify persistence. Timing varies by filesystem and load; work/output assertions are the durable checks. Reproduce with `npx vitest run test/compaction-index.test.ts`.

## Privacy

All dates, ids, counts, topics and excerpts are content. Manager tools resolve project/task selectors through the existing scope helpers and check `unsealed` **before discovery**, counts, dates or id lookup. A Captain cannot select another project or read the Coordinator's archive. Task event requests cannot choose another task/project or a filesystem destination. Known basename references and no-follow regular-file reads prevent traversal and symlink reads.

A retained Coordinator summary can mix projects in free text, including content written **before a project was sealed**. Task-snapshot redaction cannot reliably redact that prose. While any project is status-only, Box Yard conservatively withholds the entire mixed Coordinator compaction archive: index/context, counts/ids, summary/full/legacy reads, linked-compaction results, keyword summary hits, prior-summary carry-forward, saved recap injection, side-thread summary fallback, and the Coordinator's direct compaction-folder Read rule. Unsealed project/task histories remain available, and each scoped Captain keeps its own full history. Originals are preserved and the archive becomes readable again if the owner allows all projects' content. Existing agent context already delivered before a privacy setting changed is not retroactively erased.

Owner-name substitution applies to Box Yard instructions, never to saved index/summary content. Cached metadata does not bypass authorization: every read/list checks the current scope and identity settings first.
