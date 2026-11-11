// The Coordinator/Captain chat composer stays addressed to that chat at every width.
// The line over it holds "Jump to latest" / "N new messages" (StickyScroll's JumpStore), so nothing floats over the
// box. It floats over the list's bottom edge rather than taking a row of its own: it shows while the list is scrolled
// up and hides at the bottom, and a row coming and going made the list shorter and taller each time, which moved what
// was being read and bounced the view at the bottom. It hides while it has nothing to show, which is most of the time:
// the chat's Pull requests sit in the box's own row of buttons, after the mic.
import { memo, type ComponentProps, type RefObject } from "react"
import { ArrowDown } from "lucide-react"
import { Composer, COMPOSER_FOOTER, type ComposerExtra, type ComposerHandle } from "./Composer"
import { PullRequestsButton, PullRequestsMenuItem } from "./PullRequests"
import { ComposerIcon } from "./ChatIcons"
import { useJumpState, type JumpStore } from "./StickyScroll"
import { cx } from "./ui"
import type { ProjectColor } from "../../../shared/projectColors"
import type { Attachment } from "../../../shared/types"

/** Who the chat's own box talks to: the Coordinator, or the picked project's Captain. */
export type ChatTarget = { label: string; color?: ProjectColor }

/** The line's pills: 28px with a mouse, 44px under a finger. */
const LINE_PILL =
  "flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium whitespace-nowrap focus-visible:ring-2 focus-visible:ring-yard-500/50 focus-visible:outline-none pointer-coarse:h-11 pointer-coarse:px-3.5"

export const DockComposer = memo(function DockComposer({
  jumpStore,
  chat,
  onSubmit,
  placeholder,
  label,
  historyKey,
  textareaRef,
  handleRef,
  panelRef,
  className,
  runTargetsProject,
  pullRequests = false,
  stop = null,
}: {
  jumpStore: JumpStore
  chat: ChatTarget
  /** The chat's own box: what it sends to and says. */
  onSubmit: (text: string, attachments: Attachment[], extra?: ComposerExtra) => Promise<unknown> | void
  placeholder: string
  /** The text field's name to a screen reader (Composer `label`). */
  label: string
  historyKey: string
  textareaRef: RefObject<HTMLTextAreaElement | null>
  handleRef: RefObject<ComposerHandle | null>
  panelRef: RefObject<HTMLElement | null>
  /** The footer's column (the centre chats' `chat-column overflow-hidden`); the line over the box takes it too. */
  className?: string
  /** The chat's own box has the "@" list of where tasks run: the Coordinator's (null) or this project's Captain's. */
  runTargetsProject: string | null
  /** The chat's Pull requests button, in the box's row of buttons after the mic. */
  pullRequests?: boolean
  /** While its turn runs: the box's Stop (Composer `stop`). */
  stop?: ComponentProps<typeof Composer>["stop"]
}) {
  return (
    <>
      {/* A row of no height, so the line over it floats over the list's bottom edge just above the box. It isn't in the
          footer, which clips (its column lines up with the transcript only as a scroll container); it takes the footer's
          column classes instead, so its pills line up with the box. Only the pills take clicks; the strip lets them
          through to the list. */}
      <div className="relative z-10 h-0 shrink-0">
        <div data-testid="dock-line" data-chat-float className={cx("@container/dock pointer-events-none absolute inset-x-0 bottom-0 mb-1 flex min-w-0 items-center gap-1.5 px-3 py-1 *:pointer-events-auto [&:not(:has(button))]:hidden", className)}>
          <span className="ml-auto flex shrink-0 items-center justify-end gap-1.5 empty:hidden">
            <JumpPill store={jumpStore} />
          </span>
        </div>
      </div>
      <div data-testid="chat-footer" className={cx(COMPOSER_FOOTER, "px-3", className)}>
        <Composer
          onSubmit={onSubmit}
          placeholder={placeholder}
          label={label}
          textareaRef={textareaRef}
          handleRef={handleRef}
          panelRef={panelRef}
          historyKey={historyKey}
          target={<ChatTargetIcon chat={chat} captain={runTargetsProject} />}
          runTargets
          runTargetsProject={runTargetsProject}
          stop={stop}
          tools={pullRequests ? <PullRequestsButton /> : undefined}
          toolsMenu={pullRequests ? <PullRequestsMenuItem /> : undefined}
          // The PR count beside its icon makes it a little wider than a plain button.
          toolSlots={1.25}
          className="relative"
        />
      </div>
    </>
  )
})

/** The placeholder names the recipient; this static icon says which chat it is: the Coordinator's helm, or a Captain's icon (`captain`: its project) in its project's colour. */
function ChatTargetIcon({ chat, captain }: { chat: ChatTarget; captain: string | null }) {
  return <ComposerIcon kind={captain !== null ? "captain" : "coordinator"} label={`Messaging ${chat.label}`} color={chat.color} projectId={captain} />
}

/** "↓ Jump to latest" or "↓ 3 new messages", while the list is scrolled up from its bottom. */
function JumpPill({ store }: { store: JumpStore }) {
  const { away, unread } = useJumpState(store)
  if (!away) return null
  const label = unread > 0 ? `${unread} new message${unread === 1 ? "" : "s"}` : "Jump to latest"
  return (
    <button type="button" data-testid="jump-latest" onClick={store.jump} aria-label={label} title={label} className={cx(LINE_PILL, "shrink-0 border-zinc-700 bg-zinc-900 text-zinc-100 hover:bg-zinc-800")}>
      <ArrowDown className="h-3.5 w-3.5" aria-hidden />
      <span className="@max-[22rem]/dock:sr-only">{label}</span>
    </button>
  )
}
