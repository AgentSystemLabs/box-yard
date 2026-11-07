import { Check, Clock, CloudOff, WifiOff } from "lucide-react"
import { reconnectNow, useConnection } from "../lib/connection"
import { LineIcon, TAP_AREA, cx } from "./ui"

const ACTION = cx(
  TAP_AREA,
  "shrink-0 rounded-md px-2 py-0.5 font-medium text-amber-200 hover:bg-amber-500/10 hover:text-amber-100 focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none",
)

/**
 * Over a Composer's box while the server's live stream is down (lib/connection.ts): "Reconnecting to Box Yard…" or
 * "You're offline", with Retry, then "Reconnected" for a moment. A message sent meanwhile (`held`) stays in the box and
 * goes once the stream is back; the line says so, with Send now (try anyway) and Cancel (it stays as a draft).
 */
export function ConnectionLine({ held, onSendNow, onCancel }: { held: boolean; onSendNow: () => void; onCancel: () => void }) {
  const { view } = useConnection()
  if (!held && !view) return null
  if (!held && view === "back")
    return (
      <div role="status" data-testid="connection-line" className="flex items-start gap-1.5 px-1 pb-2 text-xs text-emerald-300">
        <LineIcon icon={Check} className="h-3.5 w-3.5" />
        Reconnected
      </div>
    )
  const offline = view === "offline"
  return (
    <div role="status" data-testid="connection-line" className="flex flex-wrap items-start gap-x-2 gap-y-1 px-1 pb-2 text-xs text-amber-200">
      <span className="flex min-w-0 flex-[1_1_12rem] items-start gap-1.5">
        <LineIcon icon={held ? Clock : offline ? WifiOff : CloudOff} className="h-3.5 w-3.5" />
        <span className="min-w-0">
          {offline ? "You're offline." : "Reconnecting to Box Yard…"}
          {held && <span className="text-zinc-400"> Your message sends once it's back.</span>}
        </span>
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {held ? (
          <>
            <button type="button" className={ACTION} onClick={onSendNow}>
              Send now
            </button>
            <button type="button" className={ACTION} onClick={onCancel}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" className={ACTION} onClick={reconnectNow}>
            Retry
          </button>
        )}
      </span>
    </div>
  )
}
