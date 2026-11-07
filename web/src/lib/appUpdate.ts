// A tab that outlived a server upgrade. A phone's home-screen app is never reloaded (lib/resume.ts): iOS freezes it and
// thaws it later, and its stream reconnects to the restarted server, so it reads the new data with the old code. After
// #330 Cody's phone listed sub-tasks flat for that reason: the server sent each one's parent, the old page ignored it.
// Each stream's "hello" now names the build the server serves (index.html's entry script, server/webApp.ts webBuild);
// when it isn't the one this page loaded, the page reloads as Cody comes back to it, unless that would lose something
// (an unsent draft, a dialog with unsaved changes). Until then a toast offers Reload.
// Memory only: nothing here goes to any browser storage.
import { onResume } from "./resume"
import { draftKeys } from "./composerDraft"
import { toast } from "./toast"

/** A hello this soon after the page came back (a thawed phone app reconnecting) reloads it at once. */
export const RESUME_GRACE_MS = 10_000
/** How long the Reload toast stays when the page can't reload by itself yet. */
export const UPDATE_TOAST_MS = 30_000

/** Reloads the page; a seam for tests. */
export const reloadPage = { run: () => location.reload() }

/** The build this page loaded: its entry script, as index.html names it. Null in dev (Vite serves /src/) and tests. */
export function pageBuild(doc: Document = document): string | null {
  for (const s of doc.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')) {
    const src = s.getAttribute("src")
    if (src?.startsWith("/assets/")) return src
  }
  return null
}

let own: string | null | undefined
/** The server's build, once it differs from this page's. */
let newer: string | null = null
let toasted: string | null = null
let resumedAt = -Infinity

/** Something a reload would lose: an unsent draft (text or files), or a dialog with unsaved changes (Modal's dirty). */
export function unsavedWork(): boolean {
  return draftKeys().length > 0 || document.querySelector('[role="dialog"][data-dirty]') !== null
}

const reload = () => {
  newer = null
  reloadPage.run()
}

/** A stream's hello said the server serves `web` (lib/stream.ts). */
export function noteServerBuild(web: string | null | undefined) {
  own ??= typeof document === "undefined" ? null : pageBuild()
  if (!own || !web || web === own) return
  newer = web
  if (unsavedWork() || Date.now() - resumedAt > RESUME_GRACE_MS) return offerReload(web)
  reload()
}

/** Cody is looking at the page: ask, once per build. A hidden page just waits to be shown again. */
function offerReload(web: string) {
  if (document.hidden || toasted === web) return
  toasted = web
  toast.info("Box Yard was updated", "Reload to get the new version.", { action: { label: "Reload", onClick: reload }, duration: UPDATE_TOAST_MS })
}

/** Whether a newer build is waiting for a reload (tests). */
export const updatePending = () => newer !== null

/** Forget what this page learned (tests): `build` stands in for the page's own entry script. */
export function resetAppUpdate(build?: string | null) {
  own = build
  newer = null
  toasted = null
  resumedAt = -Infinity
}

if (typeof document !== "undefined") {
  onResume(() => {
    resumedAt = Date.now()
    // Already known (heard while hidden, or Cody waved the toast off): back on the page is the moment to reload.
    if (newer && !unsavedWork()) reload()
    else if (newer) offerReload(newer)
  })
}
