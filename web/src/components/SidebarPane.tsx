// The left sidebar as a column beside the chat (App.tsx): its right edge drags, and the width is remembered in this
// browser. Only the full column resizes: the rail keeps its fixed strip and the phone drawer (a Modal) never mounts this.
import { useState, type CSSProperties, type ReactNode } from "react"
import { ResizeHandle, useElementWidth, useResizable } from "../lib/resize"
import { THREAD_CHAT_ROOM } from "../lib/layout"
import { cx } from "./ui"

/**
 * The column's width: w-64 by default, saved under `key` once dragged. Wide enough at `max` for a long task title
 * (TASK_TITLE_MAX) to show whole; the row caps it further (SIDEBAR_SHARE, THREAD_CHAT_ROOM).
 */
export const SIDEBAR_WIDTH = { key: "box-yard:sidebar-width", defaultWidth: 256, min: 200, max: 960 } as const

/** The most of the row the column may take: the chat beside it keeps the rest (40%). */
export const SIDEBAR_SHARE = 0.6

/**
 * The drag's cap in a row `container` px wide: SIDEBAR_SHARE of it, and the chat beside it keeps THREAD_CHAT_ROOM
 * at least. In px, so 125% zoom keeps the same split.
 */
export const sidebarLimit = (container: number) =>
  Math.max(SIDEBAR_WIDTH.min, Math.min(SIDEBAR_WIDTH.max, Math.floor(container * SIDEBAR_SHARE), container - THREAD_CHAT_ROOM))

/**
 * The column's CSS width for a saved width, capped like sidebarLimit by the container (cqw), so a window that shrinks
 * after a drag squeezes the sidebar instead of the chat, without overwriting what was saved.
 */
export const sidebarWidthCss = (width: number) =>
  `max(${SIDEBAR_WIDTH.min}px, min(${width}px, ${SIDEBAR_SHARE * 100}cqw, calc(100cqw - ${THREAD_CHAT_ROOM}px)))`

/** The drag state lives here, so moving the edge re-renders neither App nor the sidebar's list (`children`). */
export function SidebarPane({ rail, children }: { rail: boolean; children: ReactNode }) {
  const [pane, setPane] = useState<HTMLDivElement | null>(null)
  const container = useElementWidth(pane?.parentElement)
  const size = useResizable({ ...SIDEBAR_WIDTH, edge: "right", limit: container == null ? undefined : sidebarLimit(container), enabled: !rail })
  return (
    <div
      ref={setPane}
      data-testid="sidebar"
      data-rail={rail || undefined}
      style={{ "--sidebar-w": sidebarWidthCss(size.width) } as CSSProperties}
      className={cx("relative shrink-0 border-r border-zinc-900", rail ? "w-14" : "w-(--sidebar-w)")}
    >
      {children}
      {!rail && <ResizeHandle {...size.handle} label="Sidebar width" className="@min-[48rem]/app:block" />}
    </div>
  )
}
