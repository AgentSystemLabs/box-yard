import { Activity, memo, useEffect, useLayoutEffect, useRef, type ReactNode } from "react"
import { Router } from "wouter"
import { useQueryClient } from "@tanstack/react-query"
import { keys, useMe, useProjects } from "./lib/queries"
import { useServerEvents } from "./lib/stream"
import { usePrefetchCaptains } from "./lib/captainPrefetch"
import { useWarmLazyParts } from "./components/LazyPart"
import { useWarmTaskOnIntent } from "./lib/taskPrefetch"
import { useCaptainPrerender, usePrerenderedCaptain } from "./lib/captainPrerender"
import { useKeptChats } from "./lib/keptChats"
import { ChatPanel } from "./components/ChatPanel"
import { CaptainTab } from "./components/CaptainTab"
import { CommandPalette } from "./components/CommandPalette"
import { ShortcutsHost } from "./components/ShortcutsHelp"
import { Toasts } from "./components/Toasts"
import { NotificationEffects } from "./components/NotificationEffects"
import { SettingsHost } from "./components/SettingsHost"
import { UsageHost } from "./components/UsageHost"
import { ConfirmHost } from "./components/ConfirmDialog"
import { FilePreviewHost } from "./components/FilePreview"
import { LightboxHost } from "./components/Lightbox"
import { HealthBanner, Login } from "./components/Views"
import { dismissOverlay, useOverlay } from "./lib/overlays"
import { COORDINATOR_CHAT, closeThread, openThreadState, restoreThread, useThreadShown } from "./lib/threads"
import { OverlayHost } from "./components/OverlayHost"
import { ChatBar } from "./components/Rails"
import { ProjectSettingsHost } from "./components/ProjectSettingsDialog"
import { useColumnsHistory, useRouteGuard, appAroundNav } from "./lib/navigation"
import { useCentreCaptain } from "./lib/centreCaptain"
import { chatRef, isPinned, keepPinsShown, setChatShowing, setRails, settleColumns, useColumnsState } from "./lib/columns"
import { panelsAt, usePanels } from "./lib/panelStack"
import { toast } from "./lib/toast"
import { useChatHistory } from "./lib/treeNav"
import { Sidebar, useStrayTreeClicks } from "./components/Sidebar"
import { SidebarPane } from "./components/SidebarPane"
import { Modal, isDialogOpen } from "./components/Modal"
import { SIDEBAR_INLINE, SIDEBAR_WIDE, closeSidebarDrawer, openSidebarDrawer, setSidebarCollapsed, useMinWidth, useSidebarCollapsed, useSidebarDrawer } from "./lib/sidebar"
import { FOCUS_SIDEBAR, focusSidebar, isChatComposer } from "./lib/sidebarFocus"

export function App() {
  const me = useMe()
  const qc = useQueryClient()
  const authed = Boolean(me.data?.authed)
  useServerEvents(authed)
  // Every Captain's conversation, in memory after the first paint, so switching to one is instant.
  usePrefetchCaptains(authed)
  // Settings, project settings and schedules load on demand; fetch them in the background so opening one is instant.
  useWarmLazyParts(authed)
  // A task's conversation starts loading when a press, a resting hover or focus says it's about to open.
  useWarmTaskOnIntent(authed)
  // A Captain's chat renders, hidden, while its sidebar row is pressed, so the click only shows it.
  useCaptainPrerender(authed)
  // Deep links and browser history settle on the app's own URLs before paint, old-style ones included.
  useRouteGuard()
  // A double click on a sidebar tree row whose first click took the row away still folds its tree.
  useStrayTreeClicks()
  // Back and Forward show the chat an entry had, where a crumb's trip said it (lib/treeNav.ts), and on a desktop the
  // chat hidden or not (lib/navigation.ts).
  useChatHistory()
  useColumnsHistory()
  const overlay = useOverlay()
  // The centre's Captain follows the task open beside it (lib/centreCaptain.ts).
  const captain = useCentreCaptain()
  // A side question in the centre's chat (the Coordinator's, or the Captain's) shares the panels' slot, the newest
  // winning: a question opening closes the panels, and a panel opening closes a question left open in that chat.
  // Pinned panels never close on their own, so beside them the question gives way, and its toast can close them.
  const centreChat = captain ?? COORDINATOR_CHAT
  const questionShown = useThreadShown(centreChat)
  const view = overlay && `${overlay.kind}:${overlay.id}`
  const slotView = useRef(view)
  useEffect(() => {
    const opened = view !== slotView.current
    slotView.current = view
    if (!view || !questionShown) return
    if (opened) closeThread(centreChat)
    else if (!panelsAt(location.href).some(isPinned)) dismissOverlay()
    else {
      const question = openThreadState(centreChat)
      closeThread(centreChat)
      const show = () => {
        dismissOverlay()
        if (question) restoreThread(centreChat, question)
      }
      toast.info("Pinned panels hold the side panel", "Close them to see the side question.", { action: { label: "Close panels", onClick: show } })
    }
  }, [view, questionShown, centreChat])

  // With the panels all closed the chat shows again (lib/columns.ts), its pin kept, so the next task opens beside it.
  const panelsOpen = Boolean(overlay)
  useLayoutEffect(() => {
    if (!panelsOpen) settleColumns()
  }, [panelsOpen])

  // The sidebar: a column beside the chat, a rail while a panel needs the room under SIDEBAR_WIDE (it never covers the
  // chat), and a drawer over it on a phone or when the rail asks for the whole list. A panel in focus leaves it be: one
  // opens in focus from the sidebar, which mustn't fold under the pointer.
  const wide = useMinWidth(SIDEBAR_WIDE)
  const inlineSidebar = useMinWidth(SIDEBAR_INLINE)
  const collapsed = useSidebarCollapsed()
  const crowded = Boolean(overlay || questionShown) && !wide
  const rail = collapsed || crowded
  const drawer = useSidebarDrawer()
  const expand = () => {
    if (collapsed) setSidebarCollapsed(false)
    if (crowded) openSidebarDrawer()
  }

  useEffect(() => {
    if (!authed) return
    // Phones unmount the sidebar until its drawer opens. Accept focus requests here too, including those from
    // inline task panels, then let the mounted tree focus its current row on the next frame.
    const take = (e: Event) => {
      if (inlineSidebar || drawer || e.defaultPrevented || isDialogOpen() || !(e as CustomEvent<{ expand: boolean }>).detail.expand) return
      e.preventDefault()
      openSidebarDrawer()
      requestAnimationFrame(() => focusSidebar(false))
    }
    // Window runs after document-level composer pickers and popovers. Panels handle their own Escape after
    // modal steps; covering dialogs keep it. Returning focus never opens a different conversation.
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing || e.keyCode === 229 || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || isDialogOpen() || !isChatComposer(e.target)) return
      if ((e.target as Element).closest("[role=dialog]")) return
      if (focusSidebar()) e.preventDefault()
    }
    window.addEventListener(FOCUS_SIDEBAR, take)
    window.addEventListener("keydown", escape)
    return () => {
      window.removeEventListener(FOCUS_SIDEBAR, take)
      window.removeEventListener("keydown", escape)
    }
  }, [authed, inlineSidebar, drawer])

  useEffect(() => {
    const onUnauthorized = () => void qc.invalidateQueries({ queryKey: keys.me })
    window.addEventListener("box-yard:unauthorized", onUnauthorized)
    return () => window.removeEventListener("box-yard:unauthorized", onUnauthorized)
  }, [qc])

  if (me.isLoading) return null
  if (me.isError)
    return <div className="grid h-full place-items-center text-sm text-zinc-500">Can't reach the Box Yard server. Is it running?</div>
  if (!authed) return <Login />

  return (
    <Router aroundNav={appAroundNav}>
      <main data-app className="@container/app flex h-[100dvh] min-w-0 flex-col overflow-hidden">
        <HealthBanner />
        <div className="flex min-h-0 flex-1">
          {inlineSidebar && (
            <SidebarPane rail={rail}>
              <Sidebar rail={rail} onExpand={expand} />
            </SidebarPane>
          )}
          {/* The sidebar folded: a Captain's chat showing has its tasks in a bar beside it (Rails.tsx). */}
          {inlineSidebar && rail && captain !== null && <ChatBar projectId={captain} />}
          <div data-centre-chat className="min-w-0 flex-1"><CentreChat captainId={captain} conversation={overlay ? <OverlayHost view={overlay} rails={!inlineSidebar || rail} /> : undefined} /></div>
          <ColumnsSync captain={captain} rails={inlineSidebar && rail} />
        </div>
      </main>
      {drawer && (
        <Modal placement="drawer" label="Projects and tasks" onClose={closeSidebarDrawer} bodyClassName="flex min-h-0 flex-1 flex-col">
          <Sidebar drawer />
        </Modal>
      )}
      <Toasts quiet />
      <CommandPalette />
      <ShortcutsHost />
      <SettingsHost />
      <UsageHost />
      <ProjectSettingsHost />
      <ConfirmHost />
      <FilePreviewHost />
      <LightboxHost />
      <NotificationEffects />
    </Router>
  )
}

/**
 * Tells the columns (lib/columns.ts) what they read from the shell: the chat in the centre, and whether the sidebar
 * is folded on a desktop (the levels' strips). The pins on what no longer shows (Back, a chat switched in its header)
 * go. Apart from App, so a pin or an opening re-renders only this.
 */
function ColumnsSync({ captain, rails }: { captain: string | null; rails: boolean }) {
  const panels = usePanels()
  const { chatHidden } = useColumnsState()
  const chat = chatRef(captain)
  const chatShown = !panels.length || !chatHidden
  useLayoutEffect(() => {
    setChatShowing(chat)
    setRails(rails)
  }, [chat, rails])
  useEffect(() => {
    keepPinsShown([...(chatShown ? [chat] : []), ...panels])
  }, [chat, chatShown, panels])
  return null
}

const COORDINATOR = "coordinator"
const CAPTAIN = "captain:"

/**
 * The centre chat: the Coordinator, or a Captain (picked in the sidebar, or the open task's) as a top-level chat of its
 * own. Beside it, hidden, are the chats left last (lib/keptChats.ts) and a Captain whose row is pressed
 * (lib/captainPrerender.ts). Going to one shows that same instance, keyed alike in one list.
 */
function CentreChat({ captainId, conversation }: { captainId: string | null; conversation?: ReactNode }) {
  const projects = useProjects().data
  const ahead = usePrerenderedCaptain()
  const shown = captainId !== null && projects?.some((p) => p.id === captainId) ? CAPTAIN + captainId : COORDINATOR
  const chats = new Set([shown, ...useKeptChats(shown)])
  if (ahead !== null && projects?.some((p) => p.id === ahead)) chats.add(CAPTAIN + ahead)
  // In one steady order, the shown one among them: going between them only shows one and hides another, and moves no
  // chat's DOM (moving the one left behind the one shown cost a few ms a switch).
  return [...chats].sort().map((key) => (
    <Activity key={key} mode={key === shown ? "visible" : "hidden"}>
      {key === shown ? centreChat(key, conversation) : centreChat(key)}
    </Activity>
  ))
}

const centreChat = (key: string, panel?: ReactNode) => (key === COORDINATOR ? <CentreCoordinator panel={panel} /> : <CentreCaptain projectId={key.slice(CAPTAIN.length)} panel={panel} />)

/**
 * Memo'd on an id, so a hidden one never renders again while it waits: its project comes from its own subscription, which
 * is off while it's hidden, and catches up when it's shown.
 */
const CentreCaptain = memo(function CentreCaptain({ projectId, panel }: { projectId: string; panel?: ReactNode }) {
  const project = useProjects().data?.find((p) => p.id === projectId)
  return project ? <CaptainTab project={project} centre panel={panel} scrollKey={`centre:captain:${project.id}`} /> : null
})

const CentreCoordinator = memo(function CentreCoordinator({ panel }: { panel?: ReactNode }) {
  return <ChatPanel conversation={panel} />
})
