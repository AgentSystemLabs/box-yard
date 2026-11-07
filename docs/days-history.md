# Missing older chat dates

Days lists dates with retained original messages, in the browser's timezone. It does not invent
messages or activity dates from compaction summaries. The current context window, saved summaries,
and the browser's latest-message cache are separate from the original messages in SQLite.

## Check the running server first

A merged PR does not update a running process. Rebuilding the web app alone can also leave a newer
client talking to an older server. Settings → About and the authenticated `/api/health` response
show the running server's cached startup commit and start time. A checkout's current HEAD alone
does not prove which code a process loaded.

Before the retained-history API shipped in PR #10, the Captain message endpoint returned only the
latest 500 rows. On a busy Captain this can span just two days even though earlier originals remain
in `captain_messages`. The Days rail previously also fell back silently to those recent rows when
the full date index failed. It now labels them **Recent**, shows an unavailable/loading state, and
offers **Retry dates**. A missing history route identifies a server update requirement; a failed
request reports that older days may be missing.

Use the authenticated, read-only browser endpoints for the selected conversation:

- `GET /api/projects/:id/captain/history?days=1&tz=America%2FNew_York` returns one message anchor per
  visible activity day and the oldest retained message ID. It transfers no message bodies.
- `GET /api/projects/:id/captain/history?around=<messageId>` reads a bounded page around that day's
  original message. Follow `before`/`after` cursors to read adjacent pages.

The index seeks through the existing scope/timestamp index one local day at a time, including DST.
The client keeps a separate reading window of at most 200 messages and at most 80 day buttons in
the DOM. Retrying date metadata does not replace the live transcript, alter the composer draft, or
write conversation data to browser storage.

## Check retained sources without changing them

For a data audit, open the approved database read-only, enable `PRAGMA query_only=ON`, and scope
every query to the selected project's ID. Compare message counts and earliest/latest timestamps
with the latest 500 and the timezone-aware date index. Return aggregate metadata only, not content,
credentials, or other projects' rows. Do not copy a live database without its WAL, run migrations,
backfill production, or restart the live application as part of the audit.

Captain compaction markdown files and their JSON sidecars contain dated summaries and task
snapshots; those fields are not original transcripts. Compare their actual timestamps against the
retained message dates before proposing recovery. Keep summary provenance explicit. Summary text
cannot reconstruct missing original exchanges or establish their precise dates.

The reported two-day case was verified against a stale server with the old 500-row endpoint. The
retained originals and the current index covered the Captain's first local activity date onward;
saved summaries contributed no additional dates. No original recovery or compaction backfill was
needed for that case. Dates with neither retained messages nor dated summaries cannot be inferred;
a missing calendar date alone does not prove messages were deleted.

Updating and restarting a live installation is a separate deployment action. After an authorized
update, verify the running build and the full date endpoint, then retry or reload the browser.
Do not treat a client warning fix as proof that an older live server has been deployed.
