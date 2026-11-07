import { useEffect, useMemo, useState } from "react"
import { Link, useSearchParams } from "wouter"
import { AlarmClock, Bot, Check, ChevronDown, ChevronRight, Pause, Play, Plus, Trash2, Zap } from "lucide-react"
import {
  newClientId,
  useCreateSchedule,
  useDeleteSchedule,
  useProjects,
  useRunSchedule,
  useScheduleRuns,
  useSchedules,
  useSettings,
  useTaskMessages,
  useTasks,
  useUpdateSchedule,
} from "../lib/queries"
import { useScrollToHash } from "../lib/hash"
import { revealChatMessage } from "../lib/reveal"
import { isValidTimeZone, nextRuns, parseCron } from "../../../shared/cron"
import { nextRunText, plannedRun, runDayTime, scheduleWhen } from "../lib/scheduleText"
import { failureSummary } from "../lib/failure"
import { Button, Empty, Field, QuietPill, Select, StatusBadge, TAP_AREA, TimeAgo, cx, inputClass, useMinuteClock } from "./ui"
import { QuietSwitch } from "./TaskFilters"
import { isQuietRun, withoutQuiet } from "../../../shared/quiet"
import { Modal } from "./Modal"
import { Helm } from "./ShipIcons"
import { badgeStatus } from "../lib/prState"
import type { CatchUp, Schedule, ScheduleRun, ScheduleTarget, Task } from "../../../shared/types"
import { confirmDialog } from "../lib/confirm"

const PRESETS: { label: string; cron: string }[] = [
  { label: "Every 15 min", cron: "*/15 * * * *" },
  { label: "Hourly", cron: "0 * * * *" },
  { label: "Daily 9:00", cron: "0 9 * * *" },
  { label: "Weekdays 9:00", cron: "0 9 * * 1-5" },
  { label: "Mondays 10:00", cron: "0 10 * * 1" },
  { label: "Monthly 1st", cron: "0 8 1 * *" },
]

const DEFAULT_CRON = "0 9 * * 1-5"

const ACTIVE = new Set(["queued", "starting", "working", "waiting"])

/** The Schedules page: every schedule in every project. */
export function SchedulesView() {
  const schedules = useSchedules()
  const projects = useProjects()
  const settings = useSettings()
  const [creating, setCreating] = useState(false)
  const [params, setParams] = useSearchParams()
  const list = schedules.data ?? []
  useScrollToHash(Boolean(schedules.data))

  // `?new=schedule` (from the command palette) opens the dialog once.
  const wantsNew = params.get("new") === "schedule"
  useEffect(() => {
    if (!wantsNew) return
    setCreating(true)
    setParams((p) => {
      const next = new URLSearchParams(p)
      next.delete("new")
      return next
    }, { replace: true })
  }, [wantsNew, setParams])
  const orchestratorList = list.filter((s) => s.target === "orchestrator")
  const groups = (projects.data ?? [])
    .map((project) => ({ project, schedules: list.filter((s) => s.target === "project" && s.projectId === project.id) }))
    .filter((g) => g.schedules.length > 0)

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-start">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-zinc-50">
            <AlarmClock className="h-6 w-6 text-yard-400" /> Schedules
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-zinc-500">
            Recurring jobs. A project schedule starts a fresh task in its project each run, which you can watch live like any task. A Coordinator schedule
            sends its prompt to the Coordinator chat, for cross-project work like digests and reminders.
            {settings.data && (
              <span className="ml-1">
                Triggered by {settings.data.scheduler === "qstash" ? "Upstash QStash and the server's own timer" : "the server's own timer"}.
              </span>
            )}
          </p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)} className="w-full sm:w-auto">
          <Plus className="h-4 w-4" /> New schedule
        </Button>
      </header>

      {creating && <NewScheduleDialog onDone={() => setCreating(false)} />}

      {schedules.isLoading ? null : list.length === 0 ? (
        <Empty icon={<AlarmClock className="h-8 w-8" />} title="No schedules yet">
          Create one here, or tell the Coordinator something like "every morning, summarize open PRs across all repos".
        </Empty>
      ) : (
        <div className="space-y-6">
          {orchestratorList.length > 0 && (
            <ScheduleGroup title="Coordinator" icon={<Helm className="h-4 w-4" />} schedules={orchestratorList} />
          )}
          {groups.map((g) => (
            <ScheduleGroup key={g.project.id} title={g.project.name} href={`/projects/${g.project.id}?tab=schedules`} schedules={g.schedules} />
          ))}
        </div>
      )}
    </div>
  )
}

function ScheduleGroup({ title, href, icon, schedules }: { title: string; href?: string; icon?: React.ReactNode; schedules: Schedule[] }) {
  return (
    <section>
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-zinc-300">
        {icon}
        {href ? (
          <Link href={href} className="hover:text-zinc-100">
            {title}
          </Link>
        ) : (
          title
        )}
        <span className="text-xs font-normal text-zinc-600">{schedules.length}</span>
      </h2>
      <div className="space-y-3">
        {schedules.map((s) => (
          <ScheduleCard key={s.id} schedule={s} />
        ))}
      </div>
    </section>
  )
}

/** How long a card's action feedback stays ("Started" on the Run now button). */
export const FLASH_MS = 4000

const CHAT_RUN: Record<ScheduleRun["status"], { label: string; chip: string }> = {
  queued: { label: "Queued", chip: "bg-zinc-800 text-zinc-300" },
  running: { label: "Running", chip: "bg-sky-500/15 text-sky-300" },
  done: { label: "Done", chip: "bg-emerald-500/15 text-emerald-300" },
  failed: { label: "Failed", chip: "bg-red-500/15 text-red-300" },
}

const FACT = "pt-px text-xs text-zinc-500"

export function ScheduleCard({ schedule: s, expanded = false }: { schedule: Schedule; expanded?: boolean }) {
  const tasks = useTasks()
  const update = useUpdateSchedule()
  const remove = useDeleteSchedule()
  const run = useRunSchedule()
  const [open, setOpen] = useState(expanded)
  // A schedule's history is where quiet runs belong, so they show here by default.
  const [showQuiet, setShowQuiet] = useState(true)
  // What the last action did, for a moment: the Run now button says so, and screen readers hear it.
  const [flash, setFlash] = useState<{ kind: "run" | "pause"; label: string; said: string } | null>(null)
  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), FLASH_MS)
    return () => clearTimeout(t)
  }, [flash])
  const allRuns = useScheduleRuns()
  const orchestrator = s.target === "orchestrator"
  const runs = (tasks.data ?? []).filter((t) => t.scheduleId === s.id).sort((a, b) => b.createdAt - a.createdAt)
  const chatRuns = (allRuns.data ?? []).filter((r) => r.scheduleId === s.id).sort((a, b) => b.createdAt - a.createdAt)
  const live = !orchestrator && runs[0] && ACTIVE.has(runs[0].status) ? runs[0] : null
  const chatLive = orchestrator && chatRuns[0] && (chatRuns[0].status === "queued" || chatRuns[0].status === "running") ? chatRuns[0] : null

  const runNow = async () => {
    if (live || chatLive) {
      const ok = await confirmDialog({ title: "Start another run?", body: `"${s.name}" has a run going now. Start a second one alongside it?`, confirmLabel: "Start another run" })
      if (!ok) return
    }
    run.mutate(s.id, {
      onSuccess: () =>
        setFlash(orchestrator ? { kind: "run", label: "Sent", said: "Sent to the Coordinator. It runs when the chat is free." } : { kind: "run", label: "Started", said: "Run started." }),
    })
  }
  const togglePaused = () => {
    const enabled = !s.enabled
    update.mutate({ id: s.id, enabled })
    const now = Date.now()
    const next = enabled ? plannedRun({ ...s, enabled, nextRunAt: null }, now) : null
    setFlash({
      kind: "pause",
      label: enabled ? "Resumed" : "Paused",
      said: enabled ? `Resumed. ${next === null ? "No run is planned." : `Next run ${nextRunText(next, s.timezone, now)}.`}` : "Paused. Nothing runs until you resume it.",
    })
  }

  return (
    <div id={s.id} className={cx("rounded-xl border bg-zinc-900/40 p-4", live || chatLive ? "border-sky-500/40" : "border-zinc-800/80")}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3 className="min-w-0 font-medium break-words text-zinc-100">{s.name}</h3>
        {!s.enabled && <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300 uppercase">Paused</span>}
        {chatLive && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-500/10 px-2 py-0.5 text-xs text-sky-300">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" /> {chatLive.status === "queued" ? "Queued in chat" : "Running in chat"}
          </span>
        )}
        {live && (
          <Link href={`/tasks/${live.id}`} className="inline-flex items-center gap-1.5 rounded-full bg-sky-500/10 px-2 py-0.5 text-xs text-sky-300 hover:bg-sky-500/20">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" /> Running now
          </Link>
        )}
      </div>

      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1.5 text-sm">
        <dt className={FACT}>When</dt>
        <dd className="text-zinc-200" data-testid="schedule-when">
          {scheduleWhen(s.cron, s.timezone)}
        </dd>
        <dt className={FACT}>Next</dt>
        <dd data-testid="schedule-next">
          <NextRun schedule={s} />
        </dd>
        <dt className={FACT}>Last</dt>
        <dd className="min-w-0" data-testid="schedule-last">
          {orchestrator ? (
            <LastChatRun run={chatRuns.find((r) => r.status === "done" || r.status === "failed")} ranAt={s.lastRunAt} />
          ) : (
            <LastTaskRun task={runs.find((t) => !ACTIVE.has(t.status))} ranAt={live ? null : s.lastRunAt} />
          )}
        </dd>
      </dl>

      {s.lastSkipReason && <p className="mt-2 text-xs text-amber-300/80">{s.lastSkipReason}</p>}

      {live && <LiveTail task={live} />}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="subtle" loading={run.isPending} onClick={() => void runNow()}>
          {run.isPending ? (
            "Starting…"
          ) : flash?.kind === "run" ? (
            <>
              <Check className="h-3.5 w-3.5 text-emerald-400" /> {flash.label}
            </>
          ) : (
            <>
              <Zap className="h-3.5 w-3.5" /> Run now
            </>
          )}
        </Button>
        <Button size="sm" variant={s.enabled ? "ghost" : "subtle"} onClick={togglePaused}>
          {s.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />} {s.enabled ? "Pause" : "Resume"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          title="Delete schedule"
          aria-label="Delete schedule"
          onClick={() => {
            void confirmDialog({ title: "Delete schedule?", body: `Delete the schedule "${s.name}"? Past runs stay.`, confirmLabel: "Delete schedule", danger: true }).then(
              (ok) => ok && remove.mutate(s.id),
            )
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
        <span role="status" className="sr-only">
          {flash?.said}
        </span>
      </div>

      <button onClick={() => setOpen((v) => !v)} className="mt-2 flex min-h-11 items-center gap-1 rounded-lg text-left text-xs text-zinc-500 hover:text-zinc-300 sm:min-h-0">
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        {open ? "Hide" : "Show"} prompt and {s.runCount > 0 ? `${s.runCount} ${s.runCount === 1 ? "run" : "runs"}` : "runs"}
      </button>
      {open && (
        <div className="mt-2 space-y-3">
          <div className="rounded-lg bg-zinc-950/60 px-3 py-2 text-sm whitespace-pre-wrap text-zinc-300">{s.prompt}</div>
          <div className="space-y-1 text-xs text-zinc-500">
            <div>
              Cron <code className="rounded bg-zinc-800/80 px-1.5 py-0.5 text-[11px] text-zinc-400">{s.cron}</code> in {s.timezone}
            </div>
            <div>
              Missed runs: {s.catchUp === "once" ? "catch up once" : "skip"} · Overlap: {s.allowOverlap ? "allowed" : orchestrator ? "skip if the last prompt is still queued or running" : "skip if the last run is still going"}
            </div>
          </div>
          {orchestrator ? <ChatRunList runs={chatRuns} /> : <RunList runs={runs} showQuiet={showQuiet} onShowQuiet={setShowQuiet} />}
        </div>
      )}
    </div>
  )
}

/** "Tomorrow 2:00 AM · in 7h", or why nothing is planned. */
function NextRun({ schedule: s }: { schedule: Schedule }) {
  const now = useMinuteClock()
  if (!s.enabled) return <span className="text-amber-300/90">Paused. Nothing runs until you resume it.</span>
  const at = plannedRun(s, now)
  if (at === null) return <span className="text-zinc-400">Never: no date matches this schedule.</span>
  return <span className="text-zinc-200">{nextRunText(at, s.timezone, now)}</span>
}

/** A project schedule's last finished run: how it ended and when, its summary or failure below, linking to its task. */
function LastTaskRun({ task, ranAt }: { task: Task | undefined; ranAt: number | null }) {
  if (!task) return ranAt ? <span className="text-zinc-400">Ran <TimeAgo ts={ranAt} /></span> : <span className="text-zinc-500">No runs yet</span>
  const quiet = isQuietRun(task)
  const line = quiet ? (task.summary ?? "Nothing to do") : task.status === "failed" && task.error ? failureSummary(task.error) : task.summary
  return (
    <Link href={`/tasks/${task.id}`} className="-mx-1.5 flex min-h-11 min-w-0 items-center gap-2 rounded-md px-1.5 py-1 hover:bg-zinc-800/60 sm:min-h-0">
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {quiet ? <QuietPill /> : <StatusBadge status={badgeStatus(task)} />}
          <span className="text-xs text-zinc-500">
            <TimeAgo ts={task.createdAt} />
          </span>
        </span>
        {line && <span className="mt-1 line-clamp-2 block text-zinc-300 wrap-anywhere">{line}</span>}
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-zinc-600" />
    </Link>
  )
}

/** A Coordinator schedule's last finished run, with the chat message it posted. */
function LastChatRun({ run, ranAt }: { run: ScheduleRun | undefined; ranAt: number | null }) {
  if (!run) return ranAt ? <span className="text-zinc-400">Ran <TimeAgo ts={ranAt} /></span> : <span className="text-zinc-500">No runs yet</span>
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <StatusBadge status={run.status === "failed" ? "failed" : "done"} />
      {run.error && <span className="min-w-0 truncate text-xs text-red-300/80">{run.error}</span>}
      <span className="text-xs text-zinc-500">
        <TimeAgo ts={run.createdAt} />
      </span>
      {run.chatMessageId && (
        <button className={cx(TAP_AREA, "inline-flex items-center text-xs text-yard-400 hover:text-yard-300")} onClick={() => revealChatMessage(run.chatMessageId!)}>
          View in chat
        </button>
      )}
    </div>
  )
}

/** Runs of a Coordinator schedule: each links to the chat message it injected. */
function ChatRunList({ runs }: { runs: ScheduleRun[] }) {
  if (!runs.length) return <p className="text-xs text-zinc-500">No runs yet.</p>
  return (
    <ul className="divide-y divide-zinc-900 rounded-lg border border-zinc-800/80">
      {runs.slice(0, 15).map((r) => (
        <li key={r.id} className="flex min-h-11 flex-wrap items-center gap-3 px-3 py-2 text-sm">
          <span className="min-w-0 flex-1 truncate text-zinc-200">
            {new Date(r.dueAt).toLocaleString()}
            {r.reason !== "scheduled" && <span className="ml-2 text-xs text-zinc-500">({r.reason})</span>}
            {r.error && <span className="ml-2 text-xs text-red-300/80">{r.error}</span>}
          </span>
          <span className={cx("rounded px-1.5 py-0.5 text-[11px] font-medium", CHAT_RUN[r.status].chip)}>{CHAT_RUN[r.status].label}</span>
          {r.chatMessageId ? (
            <button
              className="inline-flex min-h-11 items-center text-xs text-yard-400 hover:text-yard-300 sm:min-h-0"
              onClick={() => revealChatMessage(r.chatMessageId!)}
            >
              View in chat
            </button>
          ) : (
            <span className="text-xs text-zinc-600">waiting</span>
          )}
        </li>
      ))}
    </ul>
  )
}

/** The last few lines of a run that is going right now, updated live. */
function LiveTail({ task }: { task: Task }) {
  const messages = useTaskMessages(task.id)
  const tail = (messages.data ?? []).filter((m) => m.role === "assistant" || m.role === "tool" || m.role === "event").slice(-4)
  return (
    <Link href={`/tasks/${task.id}`} className="mt-3 block space-y-1 rounded-lg border border-zinc-800/80 bg-zinc-950 px-3 py-2 hover:border-zinc-700">
      {tail.length === 0 && <div className="text-xs text-zinc-500">{task.status === "queued" ? "Waiting for a box slot…" : "Preparing the box…"}</div>}
      {tail.map((m) =>
        m.role === "assistant" ? (
          <div key={m.id} className="flex gap-2 text-xs text-zinc-300">
            <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-500" />
            <span className="line-clamp-2">{m.content}</span>
          </div>
        ) : (
          <div key={m.id} className="truncate pl-5 font-mono text-[11px] text-zinc-600">
            › {m.content}
          </div>
        ),
      )}
      <div className="pt-0.5 text-[11px] text-sky-400">Open the live transcript →</div>
    </Link>
  )
}

function RunList({ runs, showQuiet, onShowQuiet }: { runs: Task[]; showQuiet: boolean; onShowQuiet: (show: boolean) => void }) {
  if (!runs.length) return <p className="text-xs text-zinc-500">No runs yet.</p>
  const quiet = runs.filter(isQuietRun).length
  const shown = withoutQuiet(runs, showQuiet)
  return (
    <div className="space-y-2">
      {quiet > 0 && <QuietSwitch checked={showQuiet} onChange={onShowQuiet} count={quiet} />}
      {shown.length ? (
        <ul className="divide-y divide-zinc-900 rounded-lg border border-zinc-800/80">
          {shown.slice(0, 15).map((t) => (
            <li key={t.id} className={cx(isQuietRun(t) && "opacity-60 hover:opacity-100")}>
              <Link href={`/tasks/${t.id}`} className="flex min-h-11 items-center gap-3 px-3 py-2 text-sm hover:bg-zinc-900">
                <span className="min-w-0 flex-1 truncate text-zinc-200">{t.summary ?? t.title}</span>
                {isQuietRun(t) && <QuietPill />}
                <StatusBadge status={badgeStatus(t)} />
                <span className="w-16 shrink-0 text-right text-xs text-zinc-500">
                  <TimeAgo ts={t.createdAt} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-zinc-500">Only quiet runs so far.</p>
      )}
    </div>
  )
}

function NewScheduleDialog({ projectId, onDone }: { projectId?: string; onDone: () => void }) {
  const projects = useProjects()
  const settings = useSettings()
  const create = useCreateSchedule()
  const [target, setTarget] = useState<ScheduleTarget>("project")
  const [project, setProject] = useState(projectId ?? projects.data?.[0]?.id ?? "")
  const [name, setName] = useState("")
  const [cron, setCron] = useState(DEFAULT_CRON)
  const [timezone, setTimezone] = useState<string | null>(null)
  const [prompt, setPrompt] = useState("")
  const [catchUp, setCatchUp] = useState<CatchUp>("once")
  const [allowOverlap, setAllowOverlap] = useState(false)
  const tz = timezone ?? settings.data?.defaultTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const zones = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone")
    } catch {
      return []
    }
  }, [])

  const preview = useMemo(() => {
    try {
      if (!isValidTimeZone(tz)) return { error: `Unknown time zone "${tz}"` }
      parseCron(cron)
      const now = Date.now()
      const next = nextRuns(cron, now, tz, 3)
      if (!next.length) return { error: "This never runs." }
      return { description: scheduleWhen(cron, tz), next: next.map((ts) => runDayTime(ts, tz, now)) }
    } catch (err) {
      return { error: (err as Error).message }
    }
  }, [cron, tz])

  const orchestrator = !projectId && target === "orchestrator"
  const valid = Boolean((orchestrator || project) && name.trim() && prompt.trim() && !preview.error)
  const dirty = Boolean(name || prompt || cron !== DEFAULT_CRON || timezone !== null)

  return (
    <Modal
      size="lg"
      title="New schedule"
      dirty={dirty}
      onClose={onDone}
      onSubmit={(e) => {
        e.preventDefault()
        if (!valid) return
        create.mutate({ id: newClientId("sch"), target: orchestrator ? "orchestrator" : "project", projectId: orchestrator ? null : project, name: name.trim(), cron: cron.trim(), timezone: tz, prompt: prompt.trim(), catchUp, allowOverlap })
        onDone()
      }}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!valid}>
            Create schedule
          </Button>
        </>
      }
    >
      {!projectId && (
        <Field label="Target">
          <div className="grid gap-2 sm:flex">
            {(["project", "orchestrator"] as const).map((t) => (
              <button
                type="button"
                key={t}
                onClick={() => setTarget(t)}
                className={cx("min-h-11 rounded-md px-3 py-2 text-xs sm:min-h-0 sm:py-1", target === t ? "bg-yard-500/20 text-yard-300" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200")}
              >
                {t === "project" ? "Project (starts a task)" : "Coordinator (message in chat)"}
              </button>
            ))}
          </div>
        </Field>
      )}
      <div className={cx("grid gap-3", !projectId && !orchestrator && "sm:grid-cols-2")}>
        <Field label="Name">
          <input autoFocus className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Morning issue triage" />
        </Field>
        {!projectId && !orchestrator && (
          <Field label="Project">
            <Select className="w-full" value={project} onChange={(e) => setProject(e.target.value)}>
              {projects.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>

      <Field label="When">
        <div className="mb-2 flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button
              type="button"
              key={p.cron}
              onClick={() => setCron(p.cron)}
              className={cx("min-h-11 rounded-md px-2 py-1 text-xs sm:min-h-0 sm:py-0.5", cron === p.cron ? "bg-yard-500/20 text-yard-300" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200")}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="grid gap-2 sm:grid-cols-[1fr_14rem]">
          <input className={cx(inputClass, "font-mono")} value={cron} onChange={(e) => setCron(e.target.value)} placeholder="min hour day month weekday" />
          <input className={inputClass} value={tz} onChange={(e) => setTimezone(e.target.value)} list="box-yard-zones" placeholder="Time zone" />
          <datalist id="box-yard-zones">
            {zones.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
        </div>
        <span className="mt-1.5 block text-xs">
          {preview.error ? (
            <span className="text-red-300">{preview.error}</span>
          ) : (
            <span className="text-zinc-400">
              {preview.description} · next: {preview.next!.join(", ")}
            </span>
          )}
        </span>
      </Field>

      <Field
        label={orchestrator ? "What should the Coordinator do each run?" : "What should the agent do each run?"}
        hint={
          orchestrator
            ? 'Each run posts "[Scheduled: name] <this prompt>" in the chat; it waits until the Coordinator is free.'
            : "Each run is a new task with this prompt, plus a note on how the previous run ended."
        }
      >
        <textarea className={inputClass} rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Look at issues opened since the last run, label them, and post a summary as an artifact." />
      </Field>

      <div className="flex flex-col gap-3 text-xs text-zinc-400 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-5 sm:gap-y-2">
        <label className="flex flex-wrap items-center gap-2">
          Missed runs
          <Select size="sm" value={catchUp} onChange={(e) => setCatchUp(e.target.value as CatchUp)}>
            <option value="once">catch up once</option>
            <option value="skip">skip</option>
          </Select>
        </label>
        <label className="flex min-h-11 items-center gap-2 sm:min-h-0">
          <input type="checkbox" checked={allowOverlap} onChange={(e) => setAllowOverlap(e.target.checked)} />
          Start even if the last run is still going
        </label>
      </div>
    </Modal>
  )
}
