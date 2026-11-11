import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react"
import { Link, useSearchParams } from "wouter"
import { AlarmClock, Bot, Check, ChevronDown, ChevronRight, Pause, Pencil, Play, Plus, Trash2, Zap } from "lucide-react"
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
import { nextRunText, plannedRun, runDayTime, scheduleWhen, zoneTime } from "../lib/scheduleText"
import {
  DEFAULT_WHEN,
  REPEAT_KINDS,
  WEEKDAY_LONG,
  WEEKDAY_SHORT,
  cronFromParts,
  hasTime,
  partsFromCron,
  runsText,
  timeParts,
  timeValue,
  zoneOptions,
  type RepeatKind,
  type WhenParts,
} from "../lib/scheduleForm"
import { failureSummary } from "../lib/failure"
import { Button, Chip, Empty, Field, FieldGroup, PrChip, QuietPill, Select, TAP_AREA, TimeAgo, cx, inputClass, useMinuteClock } from "./ui"
import { QuietSwitch } from "./TaskFilters"
import { TaskStatusIcon } from "./TaskIcon"
import { isQuietRun, withoutQuiet } from "../../../shared/quiet"
import { RUNNER_LABEL } from "../../../shared/runner"
import { Modal } from "./Modal"
import { Helm } from "./ShipIcons"
import type { CatchUp, Schedule, ScheduleRun, ScheduleTarget, Task } from "../../../shared/types"
import { confirmDialog } from "../lib/confirm"

const ACTIVE = new Set(["queued", "starting", "working", "waiting"])

/** What a new schedule's form opens with: where it runs, and (for the empty state's examples) its text. */
interface Prefill {
  target?: ScheduleTarget
  projectId?: string
  name?: string
  cron?: string
  prompt?: string
}

/** The empty state's examples. They only fill the form: nothing is created until it is saved. */
const STARTERS: (Prefill & { label: string })[] = [
  {
    label: "Morning PR digest (Coordinator)",
    target: "orchestrator",
    name: "Morning PR digest",
    cron: "0 9 * * 1-5",
    prompt: "Summarize the pull requests open across all projects: what is waiting for review, what has failing checks and what is ready to merge.",
  },
  {
    label: "Nightly dependency check (project)",
    target: "project",
    name: "Nightly dependency check",
    cron: "0 2 * * *",
    prompt: "Check this project's dependencies for outdated or vulnerable packages. If nothing needs an update, change nothing and say so. Otherwise open one pull request with the safe updates.",
  },
]

/** A past run's time in the reader's own clock, like every other time in a task list. */
const readerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

/** The Schedules page: every schedule in every project. */
export function SchedulesView() {
  const schedules = useSchedules()
  const projects = useProjects()
  const [creating, setCreating] = useState<Prefill | null>(null)
  const [params, setParams] = useSearchParams()
  const list = schedules.data ?? []
  useScrollToHash(Boolean(schedules.data))

  // `?new=schedule` (from the command palette) opens the dialog once.
  const wantsNew = params.get("new") === "schedule"
  useEffect(() => {
    if (!wantsNew) return
    setCreating({})
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
    <div className="@container space-y-6">
      <header className="flex flex-col gap-3 @lg:flex-row @lg:items-start">
        <div className="min-w-0 flex-1">
          {/* The panel's header already says "Schedules". */}
          <h1 className="sr-only">Schedules</h1>
          <p className="max-w-2xl text-sm text-zinc-500">Run a prompt on a timer: each run starts a fresh task in a project, or messages the Coordinator.</p>
        </div>
        <Button variant="primary" onClick={() => setCreating({})} className="w-full @lg:w-auto">
          <Plus className="h-4 w-4" /> New schedule
        </Button>
      </header>

      {creating && <ScheduleDialog prefill={creating} onDone={() => setCreating(null)} />}

      {schedules.isLoading ? null : list.length === 0 ? (
        <Empty icon={<AlarmClock className="h-8 w-8" />} title="No schedules yet">
          <p>Start from an example, or tell the Coordinator something like "every morning, summarize open PRs across all repos".</p>
          <div role="group" aria-label="Example schedules" className="mt-4 flex flex-wrap justify-center gap-2">
            {STARTERS.map(({ label, ...prefill }) => (
              <Button key={label} size="sm" className="max-w-full text-left whitespace-normal" onClick={() => setCreating(prefill)}>
                {label}
              </Button>
            ))}
          </div>
        </Empty>
      ) : (
        <div className="space-y-6">
          {orchestratorList.length > 0 && (
            <ScheduleGroup
              title="Coordinator"
              icon={<Helm className="h-4 w-4 shrink-0" />}
              schedules={orchestratorList}
              newLabel="New Coordinator schedule"
              onNew={() => setCreating({ target: "orchestrator" })}
            />
          )}
          {groups.map((g) => (
            <ScheduleGroup
              key={g.project.id}
              title={g.project.name}
              schedules={g.schedules}
              newLabel={`New schedule in ${g.project.name}`}
              onNew={() => setCreating({ target: "project", projectId: g.project.id })}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ScheduleGroup({ title, icon, schedules, newLabel, onNew }: { title: string; icon?: ReactNode; schedules: Schedule[]; newLabel: string; onNew: () => void }) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <h2 className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold text-zinc-300">
          {icon}
          <span className="min-w-0 truncate">{title}</span>
          <span className="text-xs font-normal text-zinc-600">{schedules.length}</span>
        </h2>
        <Button size="sm" variant="ghost" className="shrink-0" aria-label={newLabel} title={newLabel} onClick={onNew}>
          <Plus className="h-3.5 w-3.5" /> New
        </Button>
      </div>
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

const CHAT_REASON: Record<ScheduleRun["reason"], string | null> = { scheduled: null, manual: "Run now", "catch-up": "Catch-up" }

const FACT = "pt-px text-xs text-zinc-500"
const LIVE_CHIP = "inline-flex items-center gap-1.5 rounded-full bg-sky-500/10 px-2 py-0.5 text-xs text-sky-300"
/** A text-sized control: 44px tall, compact only for a mouse in a wide card. */
const COMPACT = "min-h-11 pointer-fine:@lg:min-h-0"

export function ScheduleCard({ schedule: s, expanded = false }: { schedule: Schedule; expanded?: boolean }) {
  const tasks = useTasks()
  const update = useUpdateSchedule()
  const remove = useDeleteSchedule()
  const run = useRunSchedule()
  const [open, setOpen] = useState(expanded)
  const [editing, setEditing] = useState(false)
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
    <div id={s.id} className={cx("@container rounded-xl border bg-zinc-900/40 p-4", live || chatLive ? "border-sky-500/40" : "border-zinc-800/80")}>
      {/* In a narrow card the title takes the whole line, and its pills go below it. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3 className="min-w-0 basis-full font-medium break-words text-zinc-100 @lg:basis-auto">
          <button type="button" title="Edit schedule" onClick={() => setEditing(true)} className={cx(TAP_AREA, "rounded text-left hover:underline")}>
            {s.name}
          </button>
        </h3>
        {!s.enabled && <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300 uppercase">Paused</span>}
        {chatLive && <span className={LIVE_CHIP}>{chatLive.status === "queued" ? "Queued in chat" : "Running in chat"}</span>}
        {live && (
          <Link href={`/tasks/${live.id}`} className={cx(TAP_AREA, LIVE_CHIP, "hover:bg-sky-500/20")}>
            {/* The words beside it already say so. */}
            <span aria-hidden className="inline-flex">
              <TaskStatusIcon task={live} size="sm" />
            </span>
            Running now
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

      {/* Four buttons don't fit a 320px phone on one line: there Run now takes its own. */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="subtle" className="@max-[21rem]:basis-full" loading={run.isPending} onClick={() => void runNow()}>
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
        <Button size="sm" variant="ghost" title="Edit schedule" aria-label={`Edit ${s.name}`} onClick={() => setEditing(true)}>
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          title="Delete schedule"
          aria-label={`Delete ${s.name}`}
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

      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className={cx(COMPACT, "mt-2 flex items-center gap-1 rounded-lg text-left text-xs text-zinc-500 hover:text-zinc-300")}>
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        {open ? "Hide" : "Show"} prompt and {s.runCount > 0 ? `${s.runCount} ${s.runCount === 1 ? "run" : "runs"}` : "runs"}
      </button>
      {open && (
        <div className="mt-2 space-y-3">
          <div className="rounded-lg bg-zinc-950/60 px-3 py-2 text-sm whitespace-pre-wrap text-zinc-300">{s.prompt}</div>
          <div className="space-y-1 text-xs text-zinc-500">
            <div>
              Cron <code className="rounded bg-zinc-800/80 px-1.5 py-0.5 text-[11px] text-zinc-400">{s.cron}</code> in <span title={s.timezone}>{zoneTime(s.timezone)}</span>
            </div>
            <div>If the server was down: {s.catchUp === "once" ? "run once when it's back" : "skip the missed runs"}</div>
            <div>
              {orchestrator ? "If the last prompt is still queued or running" : "If the last run is still going"}: {s.allowOverlap ? (orchestrator ? "send this one anyway" : "start this one anyway") : "skip this one"}
            </div>
          </div>
          {orchestrator ? <ChatRunList runs={chatRuns} /> : <RunList runs={runs} showQuiet={showQuiet} onShowQuiet={setShowQuiet} />}
        </div>
      )}

      {editing && <ScheduleDialog schedule={s} onDone={() => setEditing(false)} />}
    </div>
  )
}

/** "Tomorrow 2:00 AM · in 7h", or why nothing is planned. */
function NextRun({ schedule: s }: { schedule: Schedule }) {
  const now = useMinuteClock()
  if (!s.enabled) return <span className="text-amber-300/90">Paused. Nothing runs until you resume it.</span>
  const at = plannedRun(s, now)
  if (at === null) return <span className="text-zinc-400">Never: no date matches this schedule.</span>
  // "· in 6d" stays in one piece when the line wraps.
  const text = nextRunText(at, s.timezone, now)
  const cut = text.lastIndexOf(" · ")
  return (
    <span className="text-zinc-200">
      {text.slice(0, cut)} <span className="whitespace-nowrap">{text.slice(cut + 1)}</span>
    </span>
  )
}

/** What a finished run left behind: its summary, or in red why it failed. */
function runLine(task: Task): { text: string | null; failed: boolean } {
  const failed = task.status === "failed"
  if (isQuietRun(task)) return { text: task.summary ?? "Nothing to do", failed }
  return { text: failed && task.error ? failureSummary(task.error) : task.summary, failed }
}

/** A project schedule's last finished run: its task's icon and when, its summary or failure below, linking to its task. */
function LastTaskRun({ task, ranAt }: { task: Task | undefined; ranAt: number | null }) {
  if (!task) return ranAt ? <span className="text-zinc-400">Ran <TimeAgo ts={ranAt} /></span> : <span className="text-zinc-500">No runs yet</span>
  const { text, failed } = runLine(task)
  return (
    <Link href={`/tasks/${task.id}`} className={cx(COMPACT, "-mx-1.5 flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 hover:bg-zinc-800/60")}>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <TaskStatusIcon task={task} size="sm" />
          <span className={cx("text-xs", failed ? "task-title-failed" : "text-zinc-400")}>
            <TimeAgo ts={task.createdAt} />
          </span>
          {isQuietRun(task) && <QuietPill />}
        </span>
        {text && <span className={cx("mt-1 line-clamp-2 block wrap-anywhere", failed ? "text-red-300/90" : "text-zinc-300")}>{text}</span>}
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-zinc-600" />
    </Link>
  )
}

/** A Coordinator schedule's last finished run, with the chat message it posted. */
function LastChatRun({ run, ranAt }: { run: ScheduleRun | undefined; ranAt: number | null }) {
  if (!run) return ranAt ? <span className="text-zinc-400">Ran <TimeAgo ts={ranAt} /></span> : <span className="text-zinc-500">No runs yet</span>
  const failed = run.status === "failed"
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className={cx("text-xs", failed ? "task-title-failed" : "text-zinc-400")}>
        <TimeAgo ts={run.createdAt} />
      </span>
      {failed && <span className="min-w-0 truncate text-xs text-red-300/90">{run.error ?? "Failed"}</span>}
      {run.chatMessageId && (
        <button type="button" className={cx(TAP_AREA, "inline-flex items-center text-xs text-yard-400 hover:text-yard-300")} onClick={() => revealChatMessage(run.chatMessageId!)}>
          View in chat
        </button>
      )}
    </div>
  )
}

/** Runs of a Coordinator schedule: each links to the chat message it injected. */
function ChatRunList({ runs }: { runs: ScheduleRun[] }) {
  const now = useMinuteClock()
  if (!runs.length) return <p className="text-xs text-zinc-500">No runs yet.</p>
  const zone = readerZone()
  return (
    <ul className="divide-y divide-zinc-900 rounded-lg border border-zinc-800/80">
      {runs.slice(0, 15).map((r) => (
        <li key={r.id} className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
          <span className="min-w-0 flex-1">
            <span className={r.status === "failed" ? "task-title-failed" : "text-zinc-200"} title={new Date(r.dueAt).toLocaleString()}>
              {runDayTime(r.dueAt, zone, now)}
            </span>
            {CHAT_REASON[r.reason] && <span className="ml-2 text-xs text-zinc-500">{CHAT_REASON[r.reason]}</span>}
            {r.error && <span className="block truncate text-xs text-red-300/90">{r.error}</span>}
          </span>
          <span className={cx("rounded px-1.5 py-0.5 text-[11px] font-medium", CHAT_RUN[r.status].chip)}>{CHAT_RUN[r.status].label}</span>
          {r.chatMessageId ? (
            <button type="button" className={cx(COMPACT, "inline-flex items-center text-xs text-yard-400 hover:text-yard-300")} onClick={() => revealChatMessage(r.chatMessageId!)}>
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

/** A project schedule's runs, newest first. Every run has the schedule's name, so a row leads with when it ran. */
function RunList({ runs, showQuiet, onShowQuiet }: { runs: Task[]; showQuiet: boolean; onShowQuiet: (show: boolean) => void }) {
  const now = useMinuteClock()
  if (!runs.length) return <p className="text-xs text-zinc-500">No runs yet.</p>
  const quiet = runs.filter(isQuietRun).length
  const shown = withoutQuiet(runs, showQuiet)
  const zone = readerZone()
  return (
    <div className="space-y-2">
      {quiet > 0 && <QuietSwitch checked={showQuiet} onChange={onShowQuiet} count={quiet} />}
      {shown.length ? (
        <ul className="divide-y divide-zinc-900 rounded-lg border border-zinc-800/80">
          {shown.slice(0, 15).map((t) => {
            const { text, failed } = runLine(t)
            return (
              // The PR chip is a link of its own, so it sits beside the row's link, not inside it.
              <li key={t.id} className="flex items-center gap-2 pr-3 hover:bg-zinc-900">
                <Link href={`/tasks/${t.id}`} className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 py-2 pl-3 text-sm">
                  <TaskStatusIcon task={t} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className={failed ? "task-title-failed" : "text-zinc-200"} title={new Date(t.createdAt).toLocaleString()}>
                        {runDayTime(t.createdAt, zone, now)}
                      </span>
                      {isQuietRun(t) && <QuietPill />}
                    </span>
                    {text && <span className={cx("block truncate text-xs", failed ? "text-red-300/90" : "text-zinc-500")}>{text}</span>}
                  </span>
                </Link>
                <PrChip task={t} variant="number" className="text-xs" />
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="text-xs text-zinc-500">Only quiet runs so far.</p>
      )}
    </div>
  )
}

const OTHER_ZONE = "__other"

/**
 * The schedule form: a new one, or `schedule` to edit. It stays open until the server answers, so a refused save
 * keeps what was typed. Where an existing schedule runs can't change: the form says where instead.
 */
function ScheduleDialog({ schedule, prefill, onDone }: { schedule?: Schedule; prefill?: Prefill; onDone: () => void }) {
  const projects = useProjects()
  const settings = useSettings()
  const create = useCreateSchedule()
  const update = useUpdateSchedule()
  const now = useMinuteClock()
  const [target, setTarget] = useState<ScheduleTarget>(schedule?.target ?? prefill?.target ?? "project")
  const [project, setProject] = useState(schedule?.projectId ?? prefill?.projectId ?? "")
  const [name, setName] = useState(schedule?.name ?? prefill?.name ?? "")
  const [when, setWhen] = useState<WhenParts>(() => {
    const cron = schedule?.cron ?? prefill?.cron
    return cron ? partsFromCron(cron) : DEFAULT_WHEN
  })
  const [timezone, setTimezone] = useState<string | null>(schedule?.timezone ?? null)
  const [otherZone, setOtherZone] = useState(false)
  const [prompt, setPrompt] = useState(schedule?.prompt ?? prefill?.prompt ?? "")
  const [catchUp, setCatchUp] = useState<CatchUp>(schedule?.catchUp ?? "once")
  const [allowOverlap, setAllowOverlap] = useState(schedule?.allowOverlap ?? false)

  const orchestrator = target === "orchestrator"
  // Until the reader picks one, the project is the first in the list, whenever that list arrives.
  const projectId = project || projects.data?.[0]?.id || ""
  const browserZone = readerZone()
  const defaultZone = settings.data?.defaultTimezone ?? browserZone
  const tz = timezone ?? defaultZone
  const cron = cronFromParts(when).trim()
  const zones = useMemo(() => zoneOptions([schedule?.timezone, defaultZone, browserZone, otherZone ? null : tz], now), [schedule?.timezone, defaultZone, browserZone, otherZone, tz, now])
  const allZones = useMemo(() => {
    if (!otherZone) return []
    try {
      return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone")
    } catch {
      return []
    }
  }, [otherZone])

  const preview = useMemo((): { error: string } | { runs: string; next: string[] } => {
    if (!isValidTimeZone(tz)) return { error: tz.trim() ? `Unknown time zone "${tz}".` : "Type a time zone, like Europe/Paris." }
    if (!cron) return { error: "Type a cron expression, like 0 9 * * 1-5." }
    try {
      parseCron(cron)
      const next = nextRuns(cron, now, tz, 3)
      if (!next.length) return { error: "This never runs: no date matches it." }
      return { runs: runsText(cron, tz), next: next.map((ts) => runDayTime(ts, tz, now)) }
    } catch (err) {
      return { error: (err as Error).message }
    }
  }, [cron, tz, now])
  const whenError = "error" in preview ? preview.error : null

  // Only what the reader changed: a list that loads late (projects, the default zone) doesn't count.
  const typed = JSON.stringify([target, project, name, when, timezone, prompt, catchUp, allowOverlap])
  const [opened] = useState(typed)
  const [openedWhen] = useState(when)
  const dirty = typed !== opened

  const saving = create.isPending || update.isPending
  const failure = (create.error ?? update.error) as Error | null
  // Why the button is off, most basic first.
  const reason =
    !orchestrator && !projectId
      ? projects.isLoading
        ? "Loading your projects…"
        : "Add a project first, or pick the Coordinator as the target."
      : !name.trim()
        ? "Give the schedule a name."
        : !prompt.trim()
          ? "Say what to do each run."
          : whenError

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (reason || saving) return
    if (!schedule) {
      create.mutate(
        { id: newClientId("sch"), target, projectId: orchestrator ? null : projectId, name: name.trim(), cron, timezone: tz, prompt: prompt.trim(), catchUp, allowOverlap },
        { onSuccess: onDone },
      )
      return
    }
    // Send only what changed. An untouched timing keeps its cron exactly as it was written.
    const patch: Parameters<typeof update.mutate>[0] = { id: schedule.id }
    if (name.trim() !== schedule.name) patch.name = name.trim()
    if (prompt.trim() !== schedule.prompt) patch.prompt = prompt.trim()
    if (JSON.stringify(when) !== JSON.stringify(openedWhen) && cron !== schedule.cron) patch.cron = cron
    if (tz !== schedule.timezone) patch.timezone = tz
    if (catchUp !== schedule.catchUp) patch.catchUp = catchUp
    if (allowOverlap !== schedule.allowOverlap) patch.allowOverlap = allowOverlap
    if (Object.keys(patch).length === 1) return onDone()
    update.mutate(patch, { onSuccess: onDone })
  }

  const set = (parts: Partial<WhenParts>) => setWhen((w) => ({ ...w, ...parts }))
  const setKind = (kind: RepeatKind) =>
    // Custom opens with the cron the plain words made, ready to adjust.
    setWhen((w) => ({ ...w, kind, cron: kind === "custom" && w.kind !== "custom" ? cronFromParts(w) : w.cron }))
  const toggleWeekday = (day: number) =>
    setWhen((w) => {
      const days = w.weekdays.includes(day) ? w.weekdays.filter((d) => d !== day) : [...w.weekdays, day]
      // A week needs a day: the last one stays on.
      return days.length ? { ...w, weekdays: days } : w
    })

  const where = !schedule
    ? undefined
    : schedule.target === "orchestrator"
      ? "Messages the Coordinator"
      : `Runs in ${projects.data?.find((p) => p.id === schedule.projectId)?.name ?? "its project"}${schedule.runsOn ? ` · ${RUNNER_LABEL[schedule.runsOn]}` : ""}`

  return (
    <Modal
      size="lg"
      title={schedule ? "Edit schedule" : "New schedule"}
      description={where}
      dirty={dirty}
      onClose={onDone}
      onSubmit={submit}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={Boolean(reason)} loading={saving}>
            {schedule ? "Save schedule" : "Create schedule"}
          </Button>
        </>
      }
    >
      <div className="@container space-y-4">
        {!schedule && (
          <FieldGroup label="Target">
            <div className="flex flex-wrap gap-1.5">
              <Chip on={!orchestrator} onClick={() => setTarget("project")}>
                Project (starts a task)
              </Chip>
              <Chip on={orchestrator} onClick={() => setTarget("orchestrator")}>
                Coordinator (message in chat)
              </Chip>
            </div>
          </FieldGroup>
        )}
        <div className={cx("grid gap-3", !schedule && !orchestrator && "@lg:grid-cols-2")}>
          <Field label="Name">
            <input autoFocus={!schedule} className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Morning issue triage" />
          </Field>
          {!schedule && !orchestrator && (
            <Field label="Project">
              <Select className="w-full" value={projectId} onChange={(e) => setProject(e.target.value)}>
                {projects.data?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>

        <div className="grid gap-3 @lg:grid-cols-2">
          <Field label="Repeats">
            <Select className="w-full" value={when.kind} onChange={(e) => setKind(e.target.value as RepeatKind)}>
              {REPEAT_KINDS.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </Select>
          </Field>
          {hasTime(when.kind) && (
            <Field label="At">
              <input
                type="time"
                required
                className={inputClass}
                value={timeValue(when)}
                onChange={(e) => {
                  const at = timeParts(e.target.value)
                  if (at) set(at)
                }}
              />
            </Field>
          )}
          {when.kind === "weekly" && (
            <div className="col-span-full">
              <FieldGroup label="On">
                <div className="flex flex-wrap gap-1.5">
                  {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                    <Chip key={day} on={when.weekdays.includes(day)} onClick={() => toggleWeekday(day)} aria-label={WEEKDAY_LONG[day]} className="min-w-11 justify-center">
                      {WEEKDAY_SHORT[day]}
                    </Chip>
                  ))}
                </div>
              </FieldGroup>
            </div>
          )}
          {when.kind === "monthly" && (
            <Field label="On day" hint={when.day > 28 ? `Months without a day ${when.day} are skipped.` : undefined}>
              <Select className="w-full" value={when.day} onChange={(e) => set({ day: Number(e.target.value) })}>
                {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => (
                  <option key={day} value={day}>
                    {day}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {when.kind === "custom" && (
            <Field label="Cron expression" hint="Five fields: minute, hour, day, month, weekday.">
              <input
                className={cx(inputClass, "font-mono")}
                value={when.cron}
                onChange={(e) => set({ cron: e.target.value })}
                placeholder="0 9 * * 1-5"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={whenError !== null && isValidTimeZone(tz)}
              />
            </Field>
          )}
          <div className="space-y-1.5">
            <Field label="Time zone">
              <Select
                className="w-full"
                value={otherZone ? OTHER_ZONE : tz}
                onChange={(e) => {
                  const other = e.target.value === OTHER_ZONE
                  setOtherZone(other)
                  setTimezone(other ? tz : e.target.value)
                }}
              >
                {zones.map((z) => (
                  <option key={z.value} value={z.value}>
                    {z.label}
                  </option>
                ))}
                <option value={OTHER_ZONE}>Other…</option>
              </Select>
            </Field>
            {otherZone && (
              <>
                <input
                  className={inputClass}
                  aria-label="Time zone name"
                  value={tz}
                  onChange={(e) => setTimezone(e.target.value)}
                  list="box-yard-zones"
                  placeholder="Area/City, like Europe/Paris"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-invalid={!isValidTimeZone(tz)}
                />
                <datalist id="box-yard-zones">
                  {allZones.map((z) => (
                    <option key={z} value={z} />
                  ))}
                </datalist>
              </>
            )}
          </div>
          <p aria-live="polite" className={cx("col-span-full text-xs", whenError ? "text-red-300" : "text-zinc-400")}>
            {"error" in preview ? (
              preview.error
            ) : (
              <>
                {preview.runs} <span className="text-zinc-500">· Next: {preview.next.join(", ")}</span>
              </>
            )}
          </p>
        </div>

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

        <div className="grid gap-3 @lg:grid-cols-2 @lg:items-end">
          <Field label="If the server was down">
            <Select className="w-full" value={catchUp} onChange={(e) => setCatchUp(e.target.value as CatchUp)}>
              <option value="once">Run once when it's back</option>
              <option value="skip">Skip the missed runs</option>
            </Select>
          </Field>
          <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300">
            <input type="checkbox" className="h-4 w-4 shrink-0" checked={allowOverlap} onChange={(e) => setAllowOverlap(e.target.checked)} />
            {orchestrator ? "Send it even if the last prompt is still queued or running" : "Start it even if the last run is still going"}
          </label>
        </div>

        {failure && (
          <p role="alert" className="text-xs text-red-300">
            {schedule ? "Couldn't save the schedule" : "Couldn't create the schedule"}: {failure.message}
          </p>
        )}
        {/* Why the button below is off. The line keeps its place, so the form doesn't jump as it comes and goes. */}
        <p role="status" className="min-h-4 text-xs text-amber-300">
          {reason}
        </p>
      </div>
    </Modal>
  )
}
