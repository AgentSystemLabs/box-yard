// The task header's PR chip and the PR sheet it opens. The chip carries the one thing to know before opening it
// (lib/prDetails.ts prSignal: conflicts, failing checks, checks running, all passing...) as a glyph beside "PR #76",
// or on the PR glyph's corner when the header folds to icons. A tap opens the sheet: checks (failing ones link to
// their logs), whether it merges cleanly, the review and files changed, the tasks that worked on it, with Open on
// GitHub and Merge PR.
import { useState, type ReactNode } from "react"
import { CircleCheck, CircleDashed, CircleMinus, CircleX, FileDiff, GitMerge, TriangleAlert, type LucideIcon } from "lucide-react"
import type { PrCheck, PrDetails } from "../../../shared/prDetails"
import type { Task } from "../../../shared/types"
import { MERGE_CHIP_LABEL, MERGE_LABEL } from "../lib/mergePr"
import { checksLine, filesText, mergeLine, prSignal, reviewLine, usePrDetails, type PrLine, type PrSignal, type PrTone } from "../lib/prDetails"
import { prLabel, prNumber, prStateOf, prTooltip } from "../lib/prState"
import { navigateApp, taskSessionHref } from "../lib/navigation"
import { confirmAndSend, PENDING_TITLE, StateIcon, useMergeButton, type MergeableTask } from "./MergePr"
import { Modal } from "./Modal"
import { PrAgents } from "./PrAgents"
import { Button, HEADER_CHIP, HEADER_FOLD, LineIcon, NewTabLink, PR_STYLE, TimeAgo, cx } from "./ui"

export type PrStatusTask = MergeableTask & Pick<Task, "prMergedAt" | "prMergedBy">

const TONE_TEXT: Record<PrTone, string> = { good: "text-emerald-400", wait: "text-amber-300", bad: "text-red-400", quiet: "text-zinc-500" }
const TONE_ICON: Record<PrTone, LucideIcon> = { good: CircleCheck, wait: CircleDashed, bad: CircleX, quiet: CircleMinus }
const signalIcon = (s: PrSignal): LucideIcon => (s.kind === "conflicts" ? TriangleAlert : TONE_ICON[s.tone])

/** The PR chip: a button that opens the PR sheet (the sheet has Open on GitHub). */
export function PrStatusChip({ task }: { task: PrStatusTask }) {
  const [open, setOpen] = useState(false)
  const state = prStateOf(task)
  const live = state === "open" || state === "draft"
  const query = usePrDetails(task, live || open)
  const merge = useMergeButton(task)
  if (!state || !task.prUrl) return null
  const style = PR_STYLE[state]
  const Icon = style.icon
  const signal = live ? prSignal(query.data?.details) : null
  const SignalIcon = signal ? signalIcon(signal) : null
  const activity = merge.state === "hidden" || merge.state === "ready" ? null : merge.state
  const title = [activity && PENDING_TITLE[activity], signal && `${prLabel(task)}: ${signal.label}`, prTooltip(task), "Checks, review, files and Merge PR"].filter(Boolean).join("\n")
  return (
    <>
      <button
        type="button"
        data-pr-state={state}
        data-pr-signal={signal?.kind}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen(true)}
        className={cx(HEADER_CHIP, "border", style.chip, HEADER_FOLD.chip)}
      >
        <span className="relative inline-flex shrink-0">
          {activity ? <StateIcon state={activity} className="h-3 w-3" /> : <Icon className={cx("h-3 w-3", HEADER_FOLD.icon)} aria-hidden />}
          {/* Folded to its glyph, the signal sits on the glyph's corner. */}
          {SignalIcon && !activity && (
            <span aria-hidden data-testid="pr-signal-badge" className="absolute -right-1.5 -bottom-1 hidden rounded-full bg-zinc-950 @max-[36rem]/head:block">
              <SignalIcon className={cx("h-2.5 w-2.5", TONE_TEXT[signal!.tone])} strokeWidth={3} />
            </span>
          )}
        </span>
        <span className={HEADER_FOLD.label}>{prLabel(task)}</span>
        {activity ? (
          <span className={cx("font-normal", HEADER_FOLD.label)}>· {MERGE_CHIP_LABEL[activity]}</span>
        ) : (
          SignalIcon && <SignalIcon aria-hidden data-testid="pr-signal" className={cx("h-3.5 w-3.5 shrink-0 @max-[36rem]/head:hidden", TONE_TEXT[signal!.tone])} />
        )}
        {signal && !activity && <span className="sr-only">, {signal.label}</span>}
      </button>
      {open && <PrSheet task={task} query={query} onClose={() => setOpen(false)} />}
    </>
  )
}

const STATE_WORD = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" } as const

/** A link to another site that sits in a row of text: sky with ↗, 44px to a finger. */
const ROW_LINK = "inline-flex min-h-7 min-w-0 items-center gap-1.5 text-sky-300 hover:underline pointer-coarse:min-h-11"

function PrSheet({ task, query, onClose }: { task: PrStatusTask; query: ReturnType<typeof usePrDetails>; onClose: () => void }) {
  const answer = query.data
  const d = answer?.details ?? null
  const state = d?.state ?? prStateOf(task) ?? "open"
  const style = PR_STYLE[state]
  const Icon = style.icon
  const url = d?.url ?? task.prUrl!
  const error = answer?.error ?? (query.isError ? (query.error as Error).message : null)
  const openTask = (id: string) => {
    onClose()
    navigateApp(taskSessionHref(id))
  }
  return (
    <Modal
      title={
        <>
          <Icon className={cx("mr-1.5 inline h-4 w-4 align-[-2px]", style.link)} aria-hidden />
          PR #{d?.number ?? prNumber(task.prUrl) ?? "?"} · {STATE_WORD[state]}
        </>
      }
      description={d?.head && d.base ? <span className="font-mono wrap-anywhere">{d.head} → {d.base}</span> : undefined}
      size="md"
      placement="sheet"
      onClose={onClose}
      footer={
        <>
          <NewTabLink
            href={url}
            mark="end"
            data-testid="pr-open-github"
            className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-zinc-700 px-3.5 py-2 text-sm font-medium text-sky-300 hover:bg-zinc-800 max-sm:w-full sm:min-h-0"
          >
            Open on GitHub
          </NewTabLink>
          <SheetMergeButton task={task} />
        </>
      }
    >
      <p className="text-sm leading-snug font-medium wrap-anywhere text-zinc-100" data-testid="pr-title">
        {d?.title || task.title}
      </p>
      {query.isPending ? (
        <p role="status" className="text-sm text-zinc-500">
          Reading checks, review and files from GitHub…
        </p>
      ) : !d ? (
        <div className="space-y-2 text-sm text-zinc-400" data-testid="pr-error">
          <p>Can't show its checks, review or files: {error ?? "GitHub didn't say."}</p>
          <Button size="sm" onClick={() => void query.refetch()} loading={query.isFetching}>
            Try again
          </Button>
        </div>
      ) : (
        <PrFacts d={d} />
      )}
      {answer?.checkedAt && (
        <p className="text-xs text-zinc-500">
          From GitHub <TimeAgo ts={answer.checkedAt} />. It refreshes every minute while this page is open.
        </p>
      )}
      <PrAgents prUrl={task.prUrl!} onOpenTask={openTask} className="border-t border-zinc-800 pt-4" />
    </Modal>
  )
}

function PrFacts({ d }: { d: PrDetails }) {
  const live = d.state === "open" || d.state === "draft"
  const checks = checksLine(d.checks)
  const listed = d.checks.list.filter((c) => c.state === "failed" || c.state === "pending").slice(0, 6)
  return (
    <dl className="grid grid-cols-[3.75rem_minmax(0,1fr)] gap-x-3 gap-y-3 text-sm" data-testid="pr-facts">
      {d.state === "merged" && (
        <Fact label="Merged">
          <Line icon={GitMerge} className={PR_STYLE.merged.link} text={`Into ${d.base}${d.mergedBy ? ` by ${d.mergedBy}` : ""}`}>
            {d.mergedAt && <span className="text-zinc-500"> · <TimeAgo ts={d.mergedAt} /></span>}
          </Line>
        </Fact>
      )}
      {d.state === "closed" && (
        <Fact label="Closed">
          <Line icon={PR_STYLE.closed.icon} className={PR_STYLE.closed.link} text="Closed without merging" />
        </Fact>
      )}
      <Fact label="Checks" testId="pr-checks">
        <ToneLine line={checks} />
        {listed.length > 0 && (
          <ul className="mt-0.5">
            {listed.map((c, i) => (
              <li key={`${c.name}-${i}`}>
                <CheckLink check={c} />
              </li>
            ))}
          </ul>
        )}
        {d.checks.state !== "none" && (
          <NewTabLink href={`${d.url}/checks`} mark="end" className={cx(ROW_LINK, "text-xs")}>
            All checks on GitHub
          </NewTabLink>
        )}
      </Fact>
      {live && (
        <Fact label="Merge" testId="pr-merge">
          <ToneLine line={mergeLine(d)} icon={d.merge === "conflicts" ? TriangleAlert : undefined} />
        </Fact>
      )}
      <Fact label="Review" testId="pr-review">
        <ToneLine line={reviewLine(d.review)} />
      </Fact>
      <Fact label="Files" testId="pr-files">
        <span className="flex min-w-0 flex-wrap items-start gap-x-2 leading-5">
          <Line icon={FileDiff} className="text-zinc-400" text={filesText(d.files)} />
          <span className="font-mono text-xs leading-5 tabular-nums">
            <span className="text-emerald-400">+{d.files.additions}</span> <span className="text-red-400">−{d.files.deletions}</span>
          </span>
        </span>
        <NewTabLink href={`${d.url}/files`} mark="end" className={cx(ROW_LINK, "text-xs")}>
          Files on GitHub
        </NewTabLink>
      </Fact>
    </dl>
  )
}

function Fact({ label, testId, children }: { label: string; testId?: string; children: ReactNode }) {
  return (
    <>
      <dt className="pt-px text-xs leading-5 text-zinc-500">{label}</dt>
      <dd className="min-w-0" data-testid={testId}>
        {children}
      </dd>
    </>
  )
}

function Line({ icon, className, text, children }: { icon: LucideIcon; className: string; text: string; children?: ReactNode }) {
  return (
    <span className="flex min-w-0 items-start gap-1.5 leading-5">
      <LineIcon icon={icon} className={cx("h-4 w-4", className)} />
      <span className="min-w-0 wrap-anywhere text-zinc-100">
        {text}
        {children}
      </span>
    </span>
  )
}

function ToneLine({ line, icon }: { line: PrLine; icon?: LucideIcon }) {
  return (
    <span className="block" data-tone={line.tone}>
      <Line icon={icon ?? TONE_ICON[line.tone]} className={TONE_TEXT[line.tone]} text={line.text} />
      {line.hint && <span className="mt-0.5 block pl-5.5 text-xs leading-snug text-zinc-500">{line.hint}</span>}
    </span>
  )
}

/** A failing or running check, linked to its log. */
function CheckLink({ check }: { check: PrCheck }) {
  const tone: PrTone = check.state === "failed" ? "bad" : "wait"
  const Icon = TONE_ICON[tone]
  const body = (
    <>
      <Icon className={cx("h-3.5 w-3.5 shrink-0", TONE_TEXT[tone])} aria-label={check.state === "failed" ? "Failing" : "Running"} />
      <span className="min-w-0 truncate">{check.name}</span>
    </>
  )
  return check.url ? (
    <NewTabLink href={check.url} mark="end" className={cx(ROW_LINK, "max-w-full pl-5.5 text-xs")}>
      {body}
    </NewTabLink>
  ) : (
    <span className="flex min-h-7 items-center gap-1.5 pl-5.5 text-xs text-zinc-300 pointer-coarse:min-h-11">{body}</span>
  )
}

/** Merge PR in the sheet's footer: the shared confirm, then the button reads the request's state. */
function SheetMergeButton({ task }: { task: PrStatusTask }) {
  const { state, send } = useMergeButton(task)
  if (state === "hidden") return null
  const idle = state === "ready"
  return (
    <Button data-merge-state={state} disabled={!idle} title={PENDING_TITLE[state] ?? "Ask the agent to merge this pull request"} onClick={() => void confirmAndSend(task, send)}>
      <StateIcon state={state} className="h-4 w-4" /> {idle ? "Merge PR…" : MERGE_LABEL[state]}
    </Button>
  )
}
