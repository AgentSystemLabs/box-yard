// The two controls every column's header ends with on a desktop (lib/columns.ts), the chat's and each panel's
// alike: Pin (it stays as other things open; filled while pinned) and Close (×, top right: the panel goes, or the chat
// hides and the panels take its room). Close shows only while another column is in view: the only one has nothing to
// give its room to (its crumbs, the sidebar and Esc lead elsewhere). Pinned or not, so Pin never moves under the
// pointer: a Close that came with the pin would sit where Pin was, and a second click to unpin would close it instead.
// Each is 44px, to a mouse and a finger alike. Only beside the chat: a sheet over it (a phone, a narrow window) shows
// one panel at a time, and Back is its way out.
import { Pin, X } from "lucide-react"
import { chatRef, closeChat, closePanel, togglePinned, useChatHidden, usePinned } from "../lib/columns"
import { useChatProjectFilter } from "../lib/projectBar"
import { usePanelPlace, usePanels } from "../lib/panelStack"
import { cx } from "./ui"

const CONTROL = "grid h-11 w-11 shrink-0 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none"
/** Beside the chat only. A header with a 32px row passes `-my-1.5`, so the 44px buttons keep it as it was. */
const ROW = "hidden shrink-0 items-center @min-[35.5rem]/coord:flex"

/** `beside`: another column is in view (the chat, or another panel), so Close shows. */
function Controls({ column, name, beside, onClose, className }: { column: string; name: string; beside: boolean; onClose: () => void; className?: string }) {
  const pinned = usePinned(column)
  return (
    <div data-testid="column-controls" data-column={column} className={cx(ROW, className)}>
      <button
        type="button"
        data-testid="column-pin"
        onClick={() => togglePinned(column)}
        aria-pressed={pinned}
        aria-label={`Pin ${name}`}
        title={pinned ? `Unpin ${name}: the next thing you open replaces it` : `Pin ${name}: it stays as you open other things`}
        className={cx(CONTROL, pinned && "text-yard-300 hover:text-yard-200")}
      >
        <Pin className={cx("h-4 w-4", pinned && "fill-current")} aria-hidden />
      </button>
      {beside && (
        <button type="button" data-testid="column-close" onClick={onClose} aria-label={`Close ${name}`} title={`Close ${name}`} className={CONTROL}>
          <X className="h-5 w-5" aria-hidden />
        </button>
      )}
    </div>
  )
}

/**
 * A panel's controls, in its header (the task's, or a Captain's or a schedule's panel). Nothing outside the panels.
 * `name`: what the buttons name ("Pin Fix the login"). It's beside another column while the chat or another panel shows.
 */
export function PanelControls({ name, className }: { name: string; className?: string }) {
  const place = usePanelPlace()
  const panels = usePanels().length
  const chatHidden = useChatHidden()
  if (!place) return null
  const beside = panels > 1 || !chatHidden
  return <Controls column={place.ref} name={name} beside={beside} onClose={() => closePanel(place.index)} className={className} />
}

/**
 * The chat's controls, in its header (the Coordinator's or the Captain's in the centre). A lone chat has Pin only:
 * nothing to take its room.
 */
export function ChatControls({ name, className }: { name: string; className?: string }) {
  const column = chatRef(useChatProjectFilter())
  const beside = usePanels().length > 0
  return <Controls column={column} name={name} beside={beside} onClose={() => closeChat(column)} className={className} />
}
