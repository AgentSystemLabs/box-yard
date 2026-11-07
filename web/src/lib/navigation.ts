// The app's navigation. Old-style deep links open its views in place.
import { OVERLAY_PARAMS, STACK_PARAM, overlayAt, overlayHistoryState, overlayNavigation, readableQuery } from "./overlays"
import { panelsAt, panelsHref, panelsOpening, refOf, sameSession, stackHistoryState } from "./panelStack"
import { arrangement, chatProject, chatRef, closeUnpinnedPanels, columnsState, isDesktop, placedHref, restoreOpened, setOpened } from "./columns"
import { useLayoutEffect } from "react"
import { navigate, useLocationProperty } from "wouter/use-browser-location"
import { COORDINATOR_CHAT, closeThread } from "./threads"
import { chatProjectFilter, pickProject, pinProject, setChatProjectFilter } from "./projectBar"
import { parseSection, SETTINGS_PARAM } from "./settingsNav"
import { withoutFormerHome } from "../../../shared/formerHome"

export const APP_HOME = "/"
export const taskCardHref = (id: string) => `${APP_HOME}?task=${encodeURIComponent(id)}`
export const projectChatHref = (id: string) => `${APP_HOME}?project=${encodeURIComponent(id)}`
export const taskSessionHref = (id: string) => `${APP_HOME}?session=${encodeURIComponent(id)}`

/** null means a retired UI destination: render it as text; direct visits fall back to the app's home. */
export function appHref(href: string, origin = "http://boxyard.local"): string | null {
  let url: URL
  try { url = new URL(href, origin + APP_HOME) } catch { return null }
  if (url.origin !== origin) return href
  // A link to the app's former home opens the same page (shared/formerHome.ts).
  url.pathname = withoutFormerHome(url.pathname) ?? url.pathname
  if (/^\/(?:artifacts|uploads|api)\//.test(url.pathname)) return href
  const task = /^\/tasks\/([^/]+)\/?$/.exec(url.pathname)
  const project = /^\/projects\/([^/]+)\/?$/.exec(url.pathname)
  const settings = /^\/settings(?:\/([^/]+))?\/?$/.exec(url.pathname)
  const params = new URLSearchParams()
  // Settings links also work on old pages, including /?settings=credentials.
  if (settings || url.searchParams.has(SETTINGS_PARAM)) params.set(SETTINGS_PARAM, parseSection(settings?.[1] ?? url.searchParams.get(SETTINGS_PARAM) ?? undefined))
  if (task) params.set("session", decodeId(task[1]!))
  else if (project) {
    if (url.searchParams.get("tab") === "settings") params.set("projectSettings", decodeId(project[1]!))
    else if (url.searchParams.get("tab") === "schedules") params.set("schedule", decodeId(url.hash.slice(1)) || "all")
    else params.set("captain", decodeId(project[1]!))
  } else if (/^\/schedules\/?$/.test(url.pathname)) params.set("schedule", decodeId(url.hash.slice(1)) || "all")
  else if (url.pathname === APP_HOME) {
    // "usage": the Usage modal's range (components/UsageHost.tsx).
    for (const key of ["task", "project", ...OVERLAY_PARAMS, STACK_PARAM, "projectSettings", "preview", "usage"]) {
      const value = url.searchParams.get(key)
      if (value) params.set(key, value)
    }
    // The chat has no task cards: a link to a task's card opens the task beside the chat.
    const card = params.get("task")
    if (card) {
      params.delete("task")
      if (!params.has("session")) params.set("session", card)
    }
  } else if (!settings && !params.has(SETTINGS_PARAM)) return null
  return APP_HOME + (params.size ? readableQuery(`?${params}`) : "") + (params.has("session") && url.hash === "#queue" ? "#queue" : "")
}

const decodeId = (id: string) => {
  try { return decodeURIComponent(id) } catch { return id }
}

/** A project link makes its Captain the centre chat (a direct visit; in the app, openChat). A task link is the task's panel by now: see appHref. */
function revealDestination(href: string) {
  const project = new URL(href, location.origin).searchParams.get("project")
  if (project) pickProject(project)
}

type Options = { replace?: boolean; state?: unknown }
type Navigate = (to: string, options?: Options) => void

/** History state: the chat an entry shows (a project id, null for the Coordinator), so Back and Forward show it again. */
export const CHAT = "boxyardChat"
/** History state on a desktop: the item an entry opened, and whether its chat was hidden (lib/columns.ts). */
export const COLUMNS = "boxyardColumns"
/** History state on a desktop: what the item an entry opened was opened from (a panel's ref, or the chat's), for its crumbs. */
export const FROM = "boxyardFrom"
export type OpenedFrom = { from: string | null; opened: string }

/** Shared by the router, notifications and toasts (which navigate outside React's router). */
export function appAroundNav(nav: Navigate, to: string, options?: Options): void {
  const next = appHref(to, location.origin)
  if (next === null) return // Retired links do nothing inside the app.
  // Replacing query state inside a view (e.g. opening Settings) must keep its return history.
  if (options?.replace) return nav(next, { ...options, state: options.state ?? overlayHistoryState(next) })
  const target = overlayAt(next)
  // On a desktop an opening shows just what it opens, beside the pins: a URL naming several panels opens its last.
  if (target && isDesktop()) return showOnly(panelsAt(next).at(-1)!, nav, new URL(next, location.origin).hash)
  if (target) {
    // A phone's opening takes the rightmost unpinned panel's place (lib/columns.ts); a URL naming its panels is kept as is.
    const placed = new URL(next, location.origin).searchParams.has(STACK_PARAM) ? next : placedHref(location.href, next)
    const before = panelsAt(location.href)
    if (before.join() === panelsAt(placed).join()) return revealPanel(refOf(target))
    closeThread(COORDINATOR_CHAT)
    const overlay = overlayNavigation(placed)!
    // The same first panel with others beside it (a sub-task beside its parent): one more step in its trail.
    if (before.length && sameSession(location.href, overlay.to)) return nav(overlay.to, { ...options, state: stackHistoryState(overlay.to) })
    return nav(overlay.to, { ...options, state: overlay.state })
  }
  // A link to a project's chat is a pick of its Captain, like the sidebar's.
  const query = new URL(next, location.origin).searchParams
  const project = query.get("project")
  if (project && query.size === 1) return openChat(project)
  revealDestination(next) // Repeated clicks on the same project still pick its Captain.
  nav(next, options)
}
export const navigateApp = (to: string, options?: Options): void => appAroundNav(navigate, to, options)

/** A panel already open, opened again: scrolled into sight. */
function revealPanel(ref: string) {
  requestAnimationFrame(() => document.querySelector(`[data-panel="${CSS.escape(ref)}"]`)?.scrollIntoView?.({ block: "nearest", inline: "nearest" }))
}

// What the click that leads to an opening was in: a panel (its ref) or the chat (its ref); null for the sidebar, a
// strip, the palette. Kept for the click's own handlers only.
let clickedIn: string | null = null
function onClickCapture(e: MouseEvent) {
  const el = e.target instanceof Element ? e.target : null
  const panel = el?.closest<HTMLElement>("[data-panel]")
  const inChat = !panel && el?.closest("[data-centre-chat]") && !el.closest('[data-testid="columns"]')
  clickedIn = panel?.dataset.panel ?? (inChat ? chatRef(chatProjectFilter()) : null)
  setTimeout(() => void (clickedIn = null))
}
if (typeof document !== "undefined") document.addEventListener("click", onClickCapture, true)

/**
 * On a desktop: show `ref` (a task, a Captain, the Coordinator, a schedule) and the pins, nothing else
 * (lib/columns.ts arrangement). The chat shows when it leads, else it hides; the unpinned panels close. A step of
 * its own in history that says its chat and what it opened, so Back shows the entry before as it was. The item already
 * showing as it would is only scrolled into sight.
 */
export function showOnly(ref: string, nav: Navigate = navigate, hash = "") {
  const { chat, panels } = arrangement(ref)
  const here = location.pathname + location.search + location.hash
  // From another path (a card rendered on its own), it opens at the app's home.
  const shown = panelsHref(location.pathname === APP_HOME ? here : APP_HOME, panels)
  const to = hash && panels[0] === ref ? shown.replace(/#.*$/, "") + hash : shown
  const before = columnsState()
  const picked = chatProjectFilter()
  const project = chat === null ? picked : chatProject(chat)
  if (to === here && before.chatHidden === (chat === null) && project === picked) {
    setOpened(ref, chat !== null)
    return revealPanel(ref)
  }
  const from: OpenedFrom = { from: clickedIn, opened: ref }
  // This entry keeps its own chat and item for Back; the new one says its own.
  history.replaceState({ ...history.state, [CHAT]: picked, [COLUMNS]: { focus: before.focus, hidden: before.chatHidden } }, "")
  const own = { [CHAT]: project, [COLUMNS]: { focus: ref, hidden: chat === null }, [FROM]: from }
  if (panels.length) {
    closeThread(COORDINATOR_CHAT)
    const overlay = overlayNavigation(to)!
    nav(overlay.to, { state: { ...overlay.state, ...panelsOpening(here, overlay.to), ...own } })
  } else nav(to, { state: own })
  if (chat !== null && chat === ref && project !== null) pinProject(project)
  setChatProjectFilter(project)
  setOpened(ref, chat !== null)
}

/**
 * Back and Forward on a desktop show each entry's chat hidden or not, and its item opened, as the entry says. An entry
 * with panels that says neither (a link from elsewhere, a reload, an old-style URL) shows them as if the last was
 * clicked, and from then on says so.
 */
export function useColumnsHistory() {
  const url = useLocationProperty(() => location.pathname + location.search + location.hash)
  useLayoutEffect(() => {
    const restore = () => {
      const saved = history.state?.[COLUMNS] as { focus?: string | null; hidden?: boolean } | undefined
      if (saved) restoreOpened(saved.focus ?? null, Boolean(saved.hidden))
    }
    restore()
    window.addEventListener("popstate", restore)
    return () => window.removeEventListener("popstate", restore)
  }, [])
  useLayoutEffect(() => {
    const last = panelsAt(url).at(-1)
    if (!last || history.state?.[COLUMNS] || !isDesktop()) return
    const hidden = !arrangement(last).chat
    restoreOpened(last, hidden)
    history.replaceState({ ...history.state, [COLUMNS]: { focus: last, hidden } }, "")
  }, [url])
}

/**
 * The Coordinator or a Captain picked (the sidebar, the palette, a link): on a desktop, as anything opened, it shows
 * with just the pins (showOnly). On a phone it becomes the chat and the unpinned panels close, a step of its own.
 */
export function openChat(projectId: string | null): void {
  if (isDesktop()) return showOnly(chatRef(projectId))
  closeUnpinnedPanels(true)
  if (projectId === null) setChatProjectFilter(null)
  else pickProject(projectId)
}

/** Before paint, canonicalize direct URLs and Back/Forward without ever rendering their old views. */
export function useRouteGuard() {
  const url = useLocationProperty(() => location.pathname + location.search + location.hash)
  useLayoutEffect(() => {
    const next = appHref(url, location.origin) ?? APP_HOME
    revealDestination(next)
    // Task/project params are one-shot link intents. Consume them so opening Settings later cannot
    // reapply an earlier project pick or scroll a card the user has since moved away from.
    const consumed = new URL(next, location.origin)
    consumed.searchParams.delete("task")
    consumed.searchParams.delete("project")
    const settled = consumed.pathname + readableQuery(consumed.search) + consumed.hash
    if (settled !== url) navigate(settled, { replace: true, state: history.state })
  }, [url])
}
