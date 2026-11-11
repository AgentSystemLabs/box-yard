// The "Merge PR" button. One click (and one confirm) sends the task's agent the standard merge message
// (server/prompts.ts MERGE_REQUEST_PROMPT); the button then reads "Merge queued" or "Merge requested…" until
// that turn ends or the PR is merged or closed. Shown only for an open PR (lib/mergePr.ts).
// In the task header it's in the PR sheet (PrStatus.tsx) and the details (ⓘ); the pending states fold into the PR chip
// ("PR #76 · merging…").
import type { MouseEvent } from "react"
import { Clock, GitMerge, Loader2 } from "lucide-react"
import type { Task } from "../../../shared/types"
import { useRequestMerge } from "../lib/queries"
import { MERGE_LABEL, mergeBody, mergeButtonState, sendMergeOnce, useMergesInFlight, type MergeButtonState, type MergeTask } from "../lib/mergePr"
import { confirmDialog } from "../lib/confirm"
import { prNumber } from "../lib/prState"
import { cx } from "./ui"
import { menuItem } from "./TaskHeader"

export type MergeableTask = MergeTask & Pick<Task, "title">

export function useMergeButton(task: MergeableTask) {
  const inFlight = useMergesInFlight()
  const { mutateAsync } = useRequestMerge()
  const state = mergeButtonState(task, inFlight)
  const send = () => sendMergeOnce(task, () => mutateAsync(task.id)).catch(() => false)
  return { state, send }
}

export const PENDING_TITLE: Partial<Record<MergeButtonState, string>> = {
  sending: "Sending the merge request…",
  queued: "Merge request sent; it goes out when the agent's current turn ends.",
  requested: "The agent is merging. This clears when its turn ends or the PR is merged or closed.",
}

export function StateIcon({ state, className }: { state: MergeButtonState; className?: string }) {
  if (state === "queued") return <Clock className={className} />
  if (state === "sending" || state === "requested") return <Loader2 className={cx(className, "animate-spin")} />
  return <GitMerge className={className} />
}

/** Ask with the shared confirm dialog, wherever Merge PR is (the PR sheet, the details, a card). */
export async function confirmAndSend(task: MergeableTask, send: () => Promise<boolean>) {
  // The dialog's title is one truncated line, so the task's (often long) name goes in the body.
  const n = prNumber(task.prUrl)
  if (await confirmDialog({ title: `Merge PR #${n ?? "?"}?`, body: mergeBody(task), confirmLabel: "Send merge request" })) await send()
}

/** The task details' (ⓘ) item. `onPicked` closes the sheet before the confirm dialog opens. */
export function MergePrMenuItem({ task, onPicked }: { task: MergeableTask; onPicked: () => void }) {
  const { state, send } = useMergeButton(task)
  if (state === "hidden") return null
  return (
    <button
      type="button"
      data-merge-state={state}
      disabled={state !== "ready"}
      title={PENDING_TITLE[state]}
      className={cx(menuItem, "disabled:cursor-default disabled:text-zinc-500 disabled:hover:bg-transparent")}
      onClick={() => {
        onPicked()
        void confirmAndSend(task, send)
      }}
    >
      <StateIcon state={state} className="h-3.5 w-3.5 text-zinc-500" /> {state === "ready" ? "Merge PR…" : MERGE_LABEL[state]}
    </button>
  )
}

/** Card footers (Inbox, Yard, Recent): a compact button inside the card's link that doesn't open the task. */
export function MergePrCardButton({ task }: { task: MergeableTask }) {
  const { state, send } = useMergeButton(task)
  if (state === "hidden") return null
  const idle = state === "ready"
  const onClick = (e: MouseEvent) => {
    // The card is a link: don't open the task.
    e.preventDefault()
    e.stopPropagation()
    if (idle) void confirmAndSend(task, send)
  }
  return (
    <button
      type="button"
      data-merge-state={state}
      aria-disabled={!idle}
      aria-label={idle ? `Merge the PR of "${task.title}"` : MERGE_LABEL[state]}
      title={PENDING_TITLE[state] ?? "Ask the agent to merge this pull request"}
      onClick={onClick}
      className={cx(
        "inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md border px-2 font-medium whitespace-nowrap transition sm:-my-1 sm:min-h-6 sm:px-1.5",
        "focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:outline-none",
        idle ? "border-zinc-700 bg-zinc-800 text-zinc-200 hover:bg-zinc-700" : "cursor-default border-zinc-800 text-zinc-500",
      )}
    >
      <StateIcon state={state} className="h-3 w-3" /> {idle ? "Merge" : MERGE_LABEL[state]}
    </button>
  )
}
