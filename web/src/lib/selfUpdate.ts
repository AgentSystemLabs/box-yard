// What the Update banner says (components/UpdateBanner.tsx), from the server's update status (shared/selfUpdate.ts).
// Pure, so the wording is tested without a page. The flow: a newer main → Update → it builds in the background →
// Box Yard restarts once no reply is running → the page reconnects and offers Refresh.
import { shortSha, UPDATE_INSTALL_PHASES, UPDATE_PHASE_LABEL, updateAvailable, type UpdateStatus } from "../../../shared/selfUpdate"

export type UpdateAction = "update" | "later" | "restart" | "refresh" | "retry" | "dismiss"

export interface UpdateBannerModel {
  /** Dismissing hides this key until something new happens. */
  key: string
  tone: "info" | "progress" | "done" | "error"
  text: string
  actions: UpdateAction[]
  /** The output of a failed update, behind Details. */
  detail: string | null
  /** The commits to compare on GitHub ("What's new"). */
  compare: { from: string; to: string } | null
}

/** What this page saw of an update, so it can say "updated" once the server is back on the new version. */
export interface UpdateSeen {
  /** The commit an update built, from when this page saw it ready or restarting. */
  expecting: string | null
  /** The commit Box Yard restarted into while this page was open. */
  updatedTo: string | null
}

export const NOTHING_SEEN: UpdateSeen = { expecting: null, updatedTo: null }

/** Fold one status into what the page saw. */
export function trackUpdate(seen: UpdateSeen, s: UpdateStatus): UpdateSeen {
  if ((s.phase === "ready" || s.phase === "restarting") && s.ready && s.ready !== s.current) {
    return seen.expecting === s.ready ? seen : { ...seen, expecting: s.ready }
  }
  if (seen.expecting && s.current === seen.expecting) return { expecting: null, updatedTo: s.current }
  if (seen.expecting && s.phase === "failed") return { ...seen, expecting: null }
  return seen
}

/** "the Coordinator finishes its reply" / "the Coordinator and a Captain finish their replies" */
export function waitingText(names: string[]): string {
  if (names.length === 0) return ""
  if (names.length === 1) return `${names[0]} finishes its reply`
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} finish their replies`
}

/** The banner for this status, or null when there's nothing to say (or Cody waved it away). */
export function updateBanner(s: UpdateStatus | undefined, seen: UpdateSeen, dismissed: ReadonlySet<string>): UpdateBannerModel | null {
  if (!s?.managed) return null
  const show = (m: Omit<UpdateBannerModel, "detail" | "compare"> & Partial<UpdateBannerModel>): UpdateBannerModel | null =>
    dismissed.has(m.key) ? null : { detail: null, compare: null, ...m }

  const step = UPDATE_INSTALL_PHASES.indexOf(s.phase)
  if (step >= 0) {
    return show({
      key: `installing:${s.phase}`,
      tone: "progress",
      text: `Updating Box Yard in the background, step ${step + 1} of ${UPDATE_INSTALL_PHASES.length}: ${UPDATE_PHASE_LABEL[s.phase].toLowerCase()}. You can keep working.`,
      actions: [],
    })
  }
  if (s.phase === "ready") {
    const to = shortSha(s.ready)
    if (s.waitingFor.length === 0) return show({ key: `ready:${s.ready}`, tone: "progress", text: `Box Yard ${to} is ready. Restarting into it…`, actions: [] })
    return show({
      key: `ready:${s.ready}`,
      tone: "progress",
      text: `Box Yard ${to} is ready. It restarts once ${waitingText(s.waitingFor)}, so nothing is cut off.`,
      actions: ["restart"],
    })
  }
  if (s.phase === "restarting") {
    return show({ key: `restarting:${s.ready}`, tone: "progress", text: `Restarting Box Yard into ${shortSha(s.ready)}… This page reconnects by itself.`, actions: [] })
  }
  if (s.phase === "failed") {
    return show({
      key: `failed:${s.last?.at ?? ""}:${s.error ?? ""}`,
      tone: "error",
      text: s.error ?? "The update didn't work.",
      detail: s.detail,
      actions: ["retry", "dismiss"],
    })
  }
  if (seen.updatedTo && s.current === seen.updatedTo) {
    return show({
      key: `updated:${seen.updatedTo}`,
      tone: "done",
      text: `Box Yard updated to ${shortSha(seen.updatedTo)}. Refresh to load the new version.`,
      actions: ["refresh", "dismiss"],
    })
  }
  if (updateAvailable(s) && s.latest && s.current) {
    const compare = { from: s.current, to: s.latest }
    if (s.failed.includes(s.latest)) {
      return show({
        key: `available:${s.latest}`,
        tone: "error",
        text: `Box Yard ${shortSha(s.latest)} didn't start last time, so this is still ${shortSha(s.current)}.`,
        actions: ["retry", "later"],
        compare,
      })
    }
    return show({
      key: `available:${s.latest}`,
      tone: "info",
      text: `A newer Box Yard is out: ${shortSha(s.current)} → ${shortSha(s.latest)}.`,
      actions: ["update", "later"],
      compare,
    })
  }
  return null
}

/** The Settings › About line: what runs, and whether it's the newest. */
export function updateSummary(s: UpdateStatus | undefined, now: number): string {
  if (!s) return "…"
  if (!s.managed) return "Started from a git checkout: update it with git pull, then ./yard local."
  if (UPDATE_INSTALL_PHASES.includes(s.phase)) return `Updating: ${UPDATE_PHASE_LABEL[s.phase].toLowerCase()}…`
  if (s.phase === "ready") return `Box Yard ${shortSha(s.ready)} is ready to restart into.`
  if (s.phase === "restarting") return "Restarting…"
  if (s.checking) return "Looking for a newer version…"
  if (s.phase === "failed") return s.error ?? "The last update didn't work."
  if (s.checkError) return s.checkError
  if (updateAvailable(s)) return `A newer version is out: ${shortSha(s.latest)}.`
  if (s.checkedAt !== null) return `Up to date (checked ${ago(now - s.checkedAt)}).`
  return "Not checked yet."
}

const ago = (ms: number) => {
  const min = Math.round(ms / 60_000)
  if (min < 1) return "just now"
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`
}
