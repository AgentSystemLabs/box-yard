// The Update banner at the top of the app (docs/npx.md › Updates). When main has a newer commit, Update builds it in
// the background while Box Yard keeps running; it restarts into it once no Coordinator, Captain or side-thread reply
// is running, and then offers Refresh. Only a Box Yard started with npx shows it (the launcher does the work).
// What it says comes from lib/selfUpdate.ts; dismissals live in memory only.
import { useEffect, useState } from "react"
import { reloadPage, setBannerOffersReload } from "../lib/appUpdate"
import { confirmDialog } from "../lib/confirm"
import { useUpdateAction, useUpdateStatus } from "../lib/queries"
import { NOTHING_SEEN, trackUpdate, updateBanner, updateSummary, waitingText, type UpdateAction, type UpdateSeen } from "../lib/selfUpdate"
import { updateAvailable } from "../../../shared/selfUpdate"
import { Button, NewTabLink, cx } from "./ui"

const TONE = {
  info: "border-sky-900/40 bg-sky-950/30 text-sky-100",
  progress: "border-zinc-800 bg-zinc-900/60 text-zinc-300",
  done: "border-emerald-900/40 bg-emerald-950/30 text-emerald-100",
  error: "border-red-900/40 bg-red-950/30 text-red-100",
} as const

const LABEL: Record<UpdateAction, string> = {
  update: "Update",
  later: "Later",
  restart: "Restart now",
  refresh: "Refresh",
  retry: "Try again",
  dismiss: "Dismiss",
}

const MAIN_ACTIONS: ReadonlySet<UpdateAction> = new Set(["update", "refresh", "retry"])

const BUTTON = "-my-3 grid min-h-11 place-items-center rounded-lg px-2 hover:underline disabled:opacity-50 sm:-my-1 sm:min-h-0"

export function UpdateBanner() {
  const s = useUpdateStatus().data
  const act = useUpdateAction()
  const [seen, setSeen] = useState<UpdateSeen>(NOTHING_SEEN)
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set())
  const [details, setDetails] = useState(false)
  // Each status the page hears moves what it saw (an update coming, then landed), in render so none is skipped.
  const now = s ? trackUpdate(seen, s) : seen
  if (now !== seen) setSeen(now)
  const banner = updateBanner(s, now, dismissed)
  // This banner says "updated, Refresh" itself, so the build-changed toast (lib/appUpdate.ts) stays quiet meanwhile.
  const offersReload = Boolean(now.expecting) || Boolean(banner?.actions.includes("refresh"))
  useEffect(() => {
    setBannerOffersReload(offersReload)
    return () => setBannerOffersReload(false)
  }, [offersReload])
  if (!banner) return null

  const run = async (a: UpdateAction) => {
    if (a === "update" || a === "retry") act.mutate("start")
    else if (a === "refresh") reloadPage.run()
    else if (a === "restart") {
      const ok = await confirmDialog({
        title: "Restart Box Yard now?",
        body: `Box Yard waits until ${waitingText(s?.waitingFor ?? [])}. Restarting now cuts that reply off. Task agents keep working either way.`,
        confirmLabel: "Restart now",
        danger: true,
      })
      if (ok) act.mutate("restart")
    } else setDismissed((d) => new Set(d).add(banner.key))
  }

  return (
    <div role="status" data-testid="update-banner" className={cx("border-b px-4 py-2 text-xs", TONE[banner.tone])}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {banner.text}
          {banner.compare && s?.repoPage && (
            <>
              {" "}
              <NewTabLink className="text-sky-300 hover:underline" href={`${s.repoPage}/compare/${banner.compare.from}...${banner.compare.to}`}>
                What's new
              </NewTabLink>
            </>
          )}
        </div>
        {banner.detail && (
          <button type="button" className={BUTTON} aria-expanded={details} onClick={() => setDetails(!details)}>
            {details ? "Hide details" : "Details"}
          </button>
        )}
        {banner.actions.map((a) => (
          <button key={a} type="button" className={cx(BUTTON, MAIN_ACTIONS.has(a) && "font-semibold")} disabled={act.isPending && a !== "dismiss" && a !== "later"} onClick={() => void run(a)}>
            {LABEL[a]}
          </button>
        ))}
      </div>
      {details && banner.detail && (
        <pre className="mt-2 max-h-48 overflow-auto rounded bg-black/30 p-2 font-mono text-[11px] whitespace-pre-wrap text-zinc-300">{banner.detail}</pre>
      )}
    </div>
  )
}

/** Settings › About › Updates: what runs, whether it's the newest, and Check now / Update. */
export function UpdateRow() {
  const s = useUpdateStatus().data
  const act = useUpdateAction()
  const [now] = useState(() => Date.now())
  const idle = s?.managed && !s.checking && (s.phase === "idle" || s.phase === "failed")
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span data-testid="update-summary">{updateSummary(s, now)}</span>
      {idle && s && (updateAvailable(s) || s.phase === "failed") && (
        <Button type="button" size="sm" variant="primary" disabled={act.isPending} onClick={() => act.mutate("start")}>
          {s.phase === "failed" ? "Try again" : "Update"}
        </Button>
      )}
      {idle && s && !updateAvailable(s) && s.phase !== "failed" && (
        <Button type="button" size="sm" disabled={act.isPending} onClick={() => act.mutate("check")}>
          Check now
        </Button>
      )}
    </div>
  )
}
