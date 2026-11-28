// A task's panel before there's a task to show: its header (☰ on a phone, Back, the panel's controls) over `children`,
// a loading skeleton or what went wrong. TaskSession shows it while the task loads, and OverlayHost while the panel's
// own chunk does, so the two waits look the same.
import type { ReactNode } from "react"
import { usePanelPlace } from "../lib/panelStack"
import { SIDEBAR_INLINE, useMinWidth } from "../lib/sidebar"
import { PanelControls } from "./ColumnControls"
import { DismissButton } from "./Modal"
import { SidebarMenuButton } from "./Sidebar"
import { CHAT_COLUMN } from "./TaskHeader"
import { cx } from "./ui"

/**
 * Beside the chat a panel is a column (ColumnControls.tsx) and its crumbs lead up, so Back is for the sheet. Side questions are a level inside the
 * panel: their Back shows instead of the controls, so the header never has both Back and × (docs/dismiss.md).
 */
export const BACK_ON_SHEET = "@min-[35.5rem]/coord:hidden"

export function TaskPanelPending({ onClose, backLabel, children }: { onClose: () => void; backLabel?: string; children: ReactNode }) {
  const inPanel = Boolean(usePanelPlace())
  const sidebarInline = useMinWidth(SIDEBAR_INLINE)
  return (
    <>
      <header className={cx(CHAT_COLUMN, "flex shrink-0 items-center gap-1.5 border-b border-zinc-800/70 py-1.5")}>
        {/* On a phone the sidebar's ☰ leads every header, as in the task's own (TaskHeader). */}
        {!sidebarInline && <SidebarMenuButton />}
        <DismissButton kind="back" onClick={onClose} label={backLabel} className={cx(sidebarInline ? "-ml-2 pointer-coarse:-ml-3" : "-ml-1", inPanel && BACK_ON_SHEET)} />
        <h2 className="min-w-0 flex-1 text-[15px] font-semibold text-zinc-50">Task conversation</h2>
        {inPanel && <PanelControls name="Task" className="-my-1.5" />}
      </header>
      <div className={cx(CHAT_COLUMN, "py-3 text-sm text-zinc-400")}>{children}</div>
    </>
  )
}
