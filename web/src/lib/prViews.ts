// "I opened this PR": every link to a GitHub pull request in the app (NewTabLink, so PrChip, the PR sheet's Open on
// GitHub and PR links in messages) says so when it's clicked, and the server counts only later comments as new on its
// tasks (server/prComments.ts). The answer comes back as a task update on the event stream, so nothing waits here.
import { prViewKey } from "../../../shared/prComments"

/**
 * A link was opened (a click, Enter, Cmd/Ctrl-click or a middle click). A GitHub PR or issue URL is reported; anything
 * else isn't. `keepalive`: a phone leaves for the GitHub app at once, and the request still goes out.
 */
export function notePrView(href: string | null | undefined) {
  if (!href || !prViewKey(href)) return
  try {
    void fetch("/api/pr-views", {
      method: "POST",
      keepalive: true,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: href }),
    }).catch(() => {})
  } catch {
    // The link opens whether or not the view is recorded.
  }
}
