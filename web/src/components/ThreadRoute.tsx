// Where each of Cody's messages in a reply thread went (shared/threadRoutes.ts): answered here by the Coordinator or
// the Captain, sent to the task's agent, or posted in the main chat. A line under the message says so, with one tap
// to send it the other way ("Send to agent instead", "Just ask instead"). Nothing is routed silently, and a message
// that couldn't be sent stays, with both ways to try again.
import { memo } from "react"
import { CornerDownRight } from "lucide-react"
import { routeOf, type RerouteTarget, type ThreadRouteInfo } from "../../../shared/threadRoutes"
import type { SideThread, SideThreadMessage } from "../../../shared/types"
import { COORDINATOR_CHAT, useRerouteThreadMessage, type ThreadChat } from "../lib/threads"
import { cx } from "./ui"

/** Who routes a chat's reply threads: its own agent. */
export const routerName = (chat: ThreadChat) => (chat === COORDINATOR_CHAT ? "Coordinator" : "Captain")

const ACTION =
  "shrink-0 rounded-sm font-medium text-yard-400 hover:text-yard-300 focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none disabled:text-zinc-600 pointer-coarse:min-h-11 pointer-coarse:px-1"

/** What the line says, and where a tap sends it instead. */
export function routeView(
  route: ThreadRouteInfo | null,
  o: { router: string; hasTask: boolean; routing: boolean; answered: boolean },
): { label: string; actions: { to: RerouteTarget; label: string }[] } | null {
  const elsewhere = o.hasTask ? { to: "agent" as const, where: "agent" } : { to: "chat" as const, where: o.router }
  if (!route) {
    if (o.routing) return { label: `${o.router} is routing it…`, actions: [] }
    // A message from before routing, answered in the thread: nothing to say.
    if (o.answered) return null
    return { label: "Not sent yet", actions: [{ to: elsewhere.to, label: `Send to ${elsewhere.where}` }, { to: "thread", label: "Ask here" }] }
  }
  const from = route.chatMessageId ? `the ${o.router}` : "the agent"
  switch (route.route) {
    case "agent":
      return { label: "sent to agent", actions: [{ to: "thread", label: "Just ask instead" }] }
    case "chat":
      return { label: `sent to ${o.router}`, actions: [{ to: "thread", label: "Just ask instead" }] }
    case "failed":
      return { label: "Not sent", actions: [{ to: elsewhere.to, label: `Send to ${elsewhere.where}` }, { to: "thread", label: "Ask again" }] }
    case "thread": {
      const label =
        route.by === "router" ? `answered by ${o.router}` : route.recalled ? `asked here · taken back from ${from}` : route.delivered ? `asked here · ${from} already had it` : "asked here"
      return { label, actions: [{ to: elsewhere.to, label: `Send to ${elsewhere.where} instead` }] }
    }
  }
}

/**
 * Under one of Cody's messages in a reply thread: where it went, and the one tap that sends it the other way.
 * `answered`: an answer (or an error) came after it, which is all a message from before routing has.
 */
export const RouteLine = memo(function RouteLine({ m, chat, thread, answered }: { m: SideThreadMessage; chat: ThreadChat; thread: SideThread; answered: boolean }) {
  const reroute = useRerouteThreadMessage(chat, thread.id)
  const route = routeOf(m.meta)
  const view = routeView(route, { router: routerName(chat), hasTask: Boolean(thread.taskId), routing: !route && (thread.busy || Boolean(m.meta?.pending)), answered })
  if (!view) return null
  return (
    <div data-testid="thread-route" data-route={route?.route ?? (thread.busy ? "routing" : "none")} className="-mt-1.5 flex flex-wrap items-center justify-end gap-x-3 gap-y-0.5 text-[11px] text-zinc-500">
      <span className="inline-flex min-w-0 items-center gap-1">
        <CornerDownRight className="h-3 w-3 shrink-0" aria-hidden />
        <span className={cx("min-w-0 wrap-anywhere", route?.route === "failed" && "text-red-300")}>{view.label}</span>
      </span>
      {view.actions.map((a) => (
        <button key={a.to} type="button" disabled={reroute.isPending} onClick={() => reroute.mutate({ messageId: m.id, to: a.to })} className={ACTION}>
          {a.label}
        </button>
      ))}
    </div>
  )
})
