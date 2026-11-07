// Box Yard's app used to live under /zen, beside older pages; now it's the whole app, at /. Links from then (bookmarks,
// notifications, a phone's home-screen icon, links in chats) open the same page without the prefix: the server
// redirects a page load (server/webApp.ts), and in-app links drop it (web/src/lib/navigation.ts appHref).
const FORMER_HOME = /^\/zen(?=[/?#]|$)/

/**
 * A path (with any query and hash) under the former home, without it: /zen?session=x is /?session=x, /zen/tasks/x is
 * /tasks/x. Null for any other path. Never a protocol-relative "//host" (an open redirect): leading slashes collapse.
 */
export function withoutFormerHome(href: string): string | null {
  if (!FORMER_HOME.test(href)) return null
  return "/" + href.replace(FORMER_HOME, "").replace(/^[/\\]+/, "")
}
