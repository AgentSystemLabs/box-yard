// The padding around every page in the main column (App.tsx), and its undo for pages whose chat runs to the bottom.

/** Inset of the page container in the main column. */
export const PAGE_PADDING = "px-4 py-4 sm:px-6 sm:py-6"

/**
 * For a full-height page whose last child is a chat (the project Captain tab): grow by the page's bottom
 * padding and pull it back with a negative margin, so its Composer sits flush with the window bottom
 * like the Coordinator panel's (Captain tab, task page). Must stay in step with PAGE_PADDING's bottom padding.
 */
export const PAGE_BLEED_BOTTOM = "-mb-4 h-[calc(100%+1rem)] sm:-mb-6 sm:h-[calc(100%+1.5rem)]"

/** The Coordinator panel's width limits, and the narrowest main column it may squeeze the page to. */
export const CHAT_MIN = 320
export const CHAT_MAX = 600
export const MAIN_MIN = 560
/** Where the projects sidebar stops being a drawer (Tailwind's lg). */
const SIDEBAR_DOCKED = 1024

/**
 * Whether the Coordinator panel sits docked beside the page, and how wide. It docks whenever the sidebar is
 * docked and the main column still gets MAIN_MIN beside a CHAT_MIN panel, so a zoomed-in laptop (1440 px at
 * 125% is 1152 CSS px) keeps the resizable panel. The saved width shrinks to fit (it isn't overwritten);
 * below that it's a drawer.
 */
export function coordinatorDock(viewport: number, sidebar: number, saved: number): { docked: boolean; width: number; max: number } {
  const max = Math.min(CHAT_MAX, viewport - sidebar - MAIN_MIN)
  const docked = viewport >= SIDEBAR_DOCKED && max >= CHAT_MIN
  return { docked, width: Math.max(CHAT_MIN, Math.min(saved, max)), max: Math.max(CHAT_MIN, max) }
}

/** The room an open side thread asks for beside the docked Coordinator, and the narrowest it may squeeze the page to. */
export const THREAD_ROOM = 416
export const MAIN_MIN_THREAD = 320

/**
 * The docked Coordinator's width while a side thread is open: wider by THREAD_ROOM (the panel slides left and the
 * thread takes the right), as far as the page keeps MAIN_MIN_THREAD; never narrower than without it.
 */
export function threadDockWidth(viewport: number, sidebar: number, width: number): number {
  return Math.max(width, Math.min(width + THREAD_ROOM, viewport - sidebar - MAIN_MIN_THREAD))
}

/**
 * The side thread panel's draggable width (SideThread.tsx) where it's a column beside a chat: THREAD_ROOM by default,
 * never under THREAD_MIN, and the chat beside it keeps THREAD_CHAT_ROOM. In px, so 125% zoom keeps the same split.
 */
export const THREAD_MIN = 272
export const THREAD_MAX = 960
export const THREAD_CHAT_ROOM = 320

/** The drag's cap in a chat `container` px wide: what's left after the chat's room, never under THREAD_MIN. */
export const threadLimit = (container: number) => Math.max(THREAD_MIN, container - THREAD_CHAT_ROOM)

/**
 * The column's CSS width for a saved width: the container caps it too (100cqw), so a window that shrinks after a drag
 * squeezes the thread instead of the chat, without overwriting what was saved.
 */
export const threadWidthCss = (width: number) => `max(${THREAD_MIN}px, min(${width}px, calc(100cqw - ${THREAD_CHAT_ROOM}px)))`

/**
 * The conversation panels (OverlayHost: a task's, then its sub-tasks' beside it). Each keeps its own width
 * (lib/panelWidths.ts), never under PANEL_MIN, and the chat beside them keeps its room: THREAD_CHAT_ROOM, or more if
 * its edge was dragged that way. Panels that don't fit scroll sideways instead of squeezing each other.
 */
export const PANEL_MIN = 288
export const PANEL_DEFAULT = THREAD_ROOM
export const PANEL_MAX = THREAD_MAX

/** A panel's drag cap in a chat `container` px wide: the whole room beside the chat, never under PANEL_MIN. */
export const panelLimit = (container: number) => Math.max(PANEL_MIN, Math.min(PANEL_MAX, container - THREAD_CHAT_ROOM))

/** A panel's CSS width for its width: the room beside the chat caps it (100cqw: the chat's section). */
export const panelWidthCss = (width: number) => `max(${PANEL_MIN}px, min(${width}px, calc(100cqw - ${THREAD_CHAT_ROOM}px)))`

/** A collapsed column's strip (Rails.tsx): 3.5rem. */
export const STRIP_WIDTH = 56

/**
 * The panels' strip: as wide as its open panels (`widths`) and its collapsed ones' strips (`strips`), as far as the
 * chat's room allows; past that it scrolls.
 */
export function stripWidthCss(widths: readonly number[], chatRoom = THREAD_CHAT_ROOM, strips = 0): string {
  const rails = `${strips * STRIP_WIDTH}px`
  if (!widths.length) return rails
  const open = `max(${PANEL_MIN}px, min(calc(${widths.map(panelWidthCss).join(" + ")}), calc(100cqw - ${chatRoom}px - ${rails})))`
  return strips ? `calc(${open} + ${rails})` : open
}

/** The panels' widths as drawn in a chat `section` px wide (panelWidthCss), and how much of them shows (stripWidthCss). */
export function stripLayout(widths: readonly number[], chatRoom: number, section: number) {
  const drawn = widths.map((w) => Math.max(PANEL_MIN, Math.min(w, section - THREAD_CHAT_ROOM)))
  const total = drawn.reduce((a, b) => a + b, 0)
  return { drawn, total, shown: Math.max(PANEL_MIN, Math.min(total, section - chatRoom)) }
}

/**
 * The edge between the chat and its panels is the first panel's left edge: a drag sets that panel's width (`first`),
 * however many panels there are, and the other panels keep theirs. The edge follows the pointer as far as the chat
 * allows: with the panels in view the strip grows and shrinks with them; with some scrolled out of view the strip is
 * already at the chat's room, so the room moves with the edge, never under THREAD_CHAT_ROOM (past that the panel
 * still grows, and the strip scrolls). Returns the first panel's width and the chat's room.
 */
export function moveChatEdge(widths: readonly number[], chatRoom: number, section: number, first: number): { first: number; chatRoom: number } {
  const { drawn, total, shown } = stripLayout(widths, chatRoom, section)
  const to = Math.max(PANEL_MIN, Math.min(first, section - THREAD_CHAT_ROOM))
  const grow = to - (drawn[0] ?? PANEL_DEFAULT)
  const room = shown < total ? section - (shown + grow) : Math.min(chatRoom, section - (total + grow))
  return { first: to, chatRoom: Math.max(THREAD_CHAT_ROOM, room) }
}
