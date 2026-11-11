// Subscription limits per login (docs/limits.md): how much of each Claude subscription's and Codex plan's 5-hour and
// weekly windows its login has used, and when each resets, as that login's runs last reported them. The Usage modal
// shows every login (SubscriptionLimits); Settings › Credentials and Identities show their own login's in a line
// (LoginLimitsLine). Every figure is visible text; the titles only repeat it.
import { memo, useId, useMemo } from "react"
import { Gauge } from "lucide-react"
import { useLimits } from "../lib/queries"
import { runDayTime, untilText } from "../lib/scheduleText"
import { Loading } from "./Loading"
import { Button, cx, timeAgo, useMinuteClock } from "./ui"
import { WARN_PCT, isCurrent, isFull, type LimitHarness, type LimitWindow, type LoginLimits } from "../../../shared/loginLimits"

const HARNESS_LABEL: Record<LimitHarness, string> = { claude: "Claude", codex: "Codex" }

const KIND_LABEL: Record<LoginLimits["kind"], string> = {
  oauth_token: "OAuth token",
  api_key: "API key",
  auth_token: "auth token",
  chatgpt: "ChatGPT login",
  local: "its own login",
}

type Tone = "full" | "warn" | "ok" | "stale"

/** Red at the limit, amber close to it, sky otherwise; a window that has reset since its reading is grey. */
function toneOf(w: LimitWindow, now: number): Tone {
  if (!isCurrent(w, now)) return "stale"
  if (isFull(w)) return "full"
  return w.status === "warning" || (w.usedPct ?? 0) >= WARN_PCT ? "warn" : "ok"
}

const BAR_TONE: Record<Tone, string> = { full: "bg-red-500", warn: "bg-amber-400", ok: "bg-sky-500", stale: "bg-zinc-600" }
const TEXT_TONE: Record<Tone, string> = { full: "text-red-300", warn: "text-amber-300", ok: "text-zinc-100", stale: "text-zinc-500" }

const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

/** "64%"; under 1 but above 0 reads "<1%", so a light week doesn't look unused. */
export function usedLabel(pct: number | null): string {
  if (pct === null) return "—"
  if (pct > 0 && pct < 1) return "<1%"
  return `${Math.round(pct * 10) / 10}%`
}

/** What a window says in words: "64% used · resets Tomorrow 9:00 AM (in 7h)", or that it has reset since. */
export function windowText(w: LimitWindow, now: number, tz = zone()): { used: string; reset: string } {
  const when = w.resetsAt === null ? null : `${runDayTime(w.resetsAt, tz, now)}`
  if (!isCurrent(w, now)) {
    return { used: when ? "reset since" : "reading expired", reset: when ? `Reset ${when}. No run since to read it again` : `Last read ${readAgo(w.asOf, now)}. No reset time was reported` }
  }
  const used = w.usedPct === null ? (isFull(w) ? "at the limit" : "Usage not reported") : `${usedLabel(w.usedPct)} used`
  return { used, reset: when ? `Resets ${when} (${untilText(w.resetsAt!, now)})` : "Reset time not reported" }
}

/** "Resets today 3:11 AM": runDayTime's day names are written for the start of a line, these come mid-sentence. */
const midSentence = (s: string) => s.replace(/\b(Today|Tomorrow)\b/g, (day) => day.toLowerCase())

/** When a reading was made, "12m ago". The clock is to the minute, so one from this minute is "just now", never "in <1m". */
const readAgo = (asOf: number, now: number) => timeAgo(Math.min(asOf, now), now)

/** The server's clock to the minute, so "in 7h" and the windows that reset since don't follow a skewed browser clock. */
function useServerMinute(report: { now: number } | undefined, fetchedAt: number): number {
  const minute = useMinuteClock()
  return report && fetchedAt ? minute + (report.now - fetchedAt) : minute
}

// ------------------------------------------------------------------ Usage modal's allowances

export function SubscriptionLimits() {
  const limits = useLimits()
  const now = useServerMinute(limits.data, limits.dataUpdatedAt)
  const logins = limits.data?.logins ?? []
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="@container min-w-0 space-y-4" data-testid="subscription-limits">
      <div className="min-w-0">
        <h3 id={headingId} className="text-base font-semibold text-zinc-100">
          Subscription allowances
        </h3>
        <p className="mt-1 text-xs text-zinc-500 wrap-anywhere">Each login's 5-hour and weekly windows, from its latest run. The range and filters below don't apply.</p>
      </div>
      {limits.isLoading ? (
        <Loading kind="rows" count={2} label="Loading subscription limits" />
      ) : limits.isError && !limits.data ? (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-800 p-4 text-sm text-zinc-400">
          <p>Subscription readings are unavailable.</p>
          <Button type="button" className="min-h-11 sm:min-h-11" onClick={() => void limits.refetch()}>Retry allowances</Button>
        </div>
      ) : !logins.length ? (
        <p className="rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-4 text-sm text-zinc-400" data-testid="limits-empty">
          No readings yet. Claude Code reports a subscription's 5-hour and weekly limits while it runs, and Codex at the end of each turn, so each login shows up here after its next run. API keys pay per token
          and have no such limits.
        </p>
      ) : (
        <ul className="grid gap-4 @3xl:grid-cols-2">
          {logins.map((l) => (
            <LoginCard key={l.loginId} login={l} now={now} />
          ))}
        </ul>
      )}
    </section>
  )
}

const LoginCard = memo(function LoginCard({ login, now }: { login: LoginLimits; now: number }) {
  const at = login.state.atLimit && login.state.resetsAt !== null && login.state.resetsAt > now ? login.state.resetsAt : null
  return (
    <li className="@container/login min-w-0 rounded-lg border border-zinc-800/80 bg-zinc-900/30 p-3 @lg:p-4" data-testid="limits-login" data-login={login.loginId}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h4 className="font-medium text-zinc-100">{HARNESS_LABEL[login.harness]}</h4>
        <span className="min-w-0 text-xs text-zinc-400 wrap-anywhere">{login.source}</span>
      </div>
      <div className="mt-0.5 text-xs text-zinc-500 wrap-anywhere">
        {loginDetail(login)} · <time title={new Date(login.asOf).toLocaleString()}>as of {readAgo(login.asOf, now)}</time>
      </div>
      {at !== null && (
        <p className="mt-2 rounded-md border border-red-900/50 bg-red-950/40 px-2 py-1 text-xs text-red-200" data-testid="limits-at-limit">
          At its limit until {midSentence(runDayTime(at, zone(), now))} ({untilText(at, now)}).
        </p>
      )}
      {/* Side by side once the card is wide enough for both; a narrow column breaks "78% remaining · resets tomorrow 12:00 AM (in 22h)" at the dot. */}
      <div className="mt-3 grid gap-3 @md/login:grid-cols-2 @md/login:gap-x-5">
        {login.windows.map((w) => (
          <WindowMeter key={w.window} w={w} now={now} who={HARNESS_LABEL[login.harness]} />
        ))}
      </div>
    </li>
  )
})

/** "OAuth token · 3fa9c2e1b0d4 · plus". */
function loginDetail(l: LoginLimits): string {
  return [KIND_LABEL[l.kind], l.fingerprint, l.plan].filter(Boolean).join(" · ")
}

function WindowMeter({ w, now, who }: { w: LimitWindow; now: number; who: string }) {
  const tone = toneOf(w, now)
  const text = windowText(w, now)
  // A missing percentage or an expired reading is unknown, never an empty (0%) allowance.
  const known = isCurrent(w, now) && w.usedPct !== null
  const fill = known ? Math.max(0, Math.min(100, w.usedPct!)) : null
  const remaining = known && !(isFull(w) && w.usedPct! < 100) ? Math.max(0, 100 - w.usedPct!) : null
  const reset = midSentence(text.reset)
  const title = `${who} ${w.label}: ${text.used}.${remaining !== null ? ` ${usedLabel(remaining)} remaining.` : ""} ${reset}. Read ${readAgo(w.asOf, now)}.`
  return (
    <div title={title} data-testid="limits-window" data-window={w.window} className="min-w-0">
      {/* Two lines around the bar: what and how much, then what's left and when it comes back. */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-sm tabular-nums">
        <span className="font-medium text-zinc-300">{w.label}</span>
        <span className={cx("font-semibold", TEXT_TONE[tone])}>{text.used}</span>
      </div>
      {fill !== null && (
        <div
          className="mt-1.5 h-2 overflow-hidden rounded-full bg-zinc-800"
          role="meter"
          title={title}
          aria-label={`${who} ${w.label} limit used`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={fill}
          aria-valuetext={`${text.used}, ${remaining === null ? "at the limit" : `${usedLabel(remaining)} remaining`}`}
        >
          <div className={cx("h-full rounded-full", BAR_TONE[tone])} style={{ width: `${fill}%` }} />
        </div>
      )}
      <div className={cx("mt-1.5 text-xs tabular-nums", tone === "full" ? "text-red-300" : "text-zinc-400")}>
        {remaining !== null ? (
          <>
            <span className="whitespace-nowrap">{usedLabel(remaining)} remaining ·</span> <span className="whitespace-nowrap">{reset[0]!.toLowerCase() + reset.slice(1)}</span>
          </>
        ) : (
          reset
        )}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ one login's line, next to where it's set

/**
 * The limits of the newest login set at `scope` (`settings`, `identity:<id>`) for `harness`, in one line of chips:
 * "5-hour 64% · Weekly 22% · as of 12m ago". Nothing until a run has read them.
 */
export function LoginLimitsLine({ scope, harness, className }: { scope: string; harness: LimitHarness; className?: string }) {
  const limits = useLimits()
  const now = useServerMinute(limits.data, limits.dataUpdatedAt)
  const login = useMemo(() => (limits.data?.logins ?? []).filter((l) => l.scope === scope && l.harness === harness).sort((a, b) => b.asOf - a.asOf)[0] ?? null, [limits.data, scope, harness])
  if (!login) return null
  const live = login.windows.filter((w) => isCurrent(w, now))
  return (
    <div className={cx("flex flex-wrap items-center gap-1.5 text-xs text-zinc-500", className)} data-testid="limits-line" data-login={login.loginId}>
      <Gauge className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden />
      <span className="text-zinc-400">{HARNESS_LABEL[harness]} limits</span>
      {live.length ? (
        live.map((w) => <WindowChip key={w.window} w={w} now={now} who={HARNESS_LABEL[harness]} />)
      ) : (
        <span>every window has reset since the last run</span>
      )}
      <time title={new Date(login.asOf).toLocaleString()}>as of {readAgo(login.asOf, now)}</time>
    </div>
  )
}

function WindowChip({ w, now, who }: { w: LimitWindow; now: number; who: string }) {
  const tone = toneOf(w, now)
  const text = windowText(w, now)
  const fill = Math.min(100, w.usedPct ?? (tone === "full" ? 100 : 0))
  return (
    <span
      className="inline-flex h-6 items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900/60 px-1.5 whitespace-nowrap"
      title={`${who} ${w.label}: ${text.used}. ${text.reset}.`}
      data-testid="limits-chip"
      data-window={w.window}
    >
      <span className="text-zinc-400">{w.label}</span>
      <span className={cx("font-semibold tabular-nums", TEXT_TONE[tone])}>{w.usedPct === null ? text.used : usedLabel(w.usedPct)}</span>
      <span className="h-1.5 w-8 overflow-hidden rounded-full bg-zinc-800" aria-hidden>
        <span className={cx("block h-full rounded-full", BAR_TONE[tone])} style={{ width: `${fill}%` }} />
      </span>
    </span>
  )
}
