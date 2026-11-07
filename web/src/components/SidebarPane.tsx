// The left sidebar as a column beside the chat (App.tsx): its right edge drags, and the width is remembered in this
// browser. Only the full column resizes: the rail keeps its fixed strip and the phone drawer (a Modal) never mounts this.
import { useState, type CSSProperties, type ReactNode } from "react"
import { ResizeHandle, useElementWidth, useResizable } from "../lib/resize"
import { THREAD_CHAT_ROOM } from "../lib/layout"
import { cx } from "./ui"

/** The column's width: w-64 by default, saved under `key` once dragged. */
export const SIDEBAR_WIDTH = { key: "box-yard:sidebar-width", defaultWidth: 256, min: 200, max: 480 } as const

/** The drag's cap in a row `container` px wide: the chat beside it keeps THREAD_CHAT_ROOM. */
export const sidebarLimit = (container: number) => Math.max(SIDEBAR_WIDTH.min, Math.min(SIDEBAR_WIDTH.max, container - THREAD_CHAT_ROOM))

/**
 * The column's CSS width for a saved width: the container caps it too (100cqw), so a window that shrinks after a
 * drag squeezes the sidebar instead of the chat, without overwriting what was saved.
 */
export const sidebarWidthCss = (width: number) => `max(${SIDEBAR_WIDTH.min}px, min(${width}px, calc(100cqw - ${THREAD_CHAT_ROOM}px)))`

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
