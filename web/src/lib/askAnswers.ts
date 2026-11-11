// The ask form's answers in progress (components/AskQuestions.tsx): where Cody is in a task's several questions and
// what they picked or typed, kept per task and ask (askKey), so leaving the task and coming back finds the form as it
// was. Memory only, like composer drafts: nothing goes to browser storage (conversation data stays in memory).
import { questionChoices, type AskQuestion } from "../../../shared/askQuestions"

/** A question's pick: the index of one of its choices (questionChoices: the default first), "custom", or none yet. */
export type AskPick = number | "custom" | null

export interface AskProgress {
  /** The question on screen. */
  step: number
  picks: AskPick[]
  /** What Cody typed as their own answer to each question, kept when they pick a choice instead. */
  custom: string[]
}

const saved = new Map<string, AskProgress>()

/** Where a task's ask keeps its progress: per task and per ask, so a new ask starts fresh. */
export const askProgressId = (taskId: string, key: string) => `${taskId}:${key}`

/** A fresh form: the first question, each question's default picked (none where it has no default). */
export function initialProgress(questions: readonly AskQuestion[]): AskProgress {
  return { step: 0, picks: questions.map((q) => (q.defaultAnswer ? 0 : null)), custom: questions.map(() => "") }
}

export function readAskProgress(id: string, questions: readonly AskQuestion[]): AskProgress {
  const p = saved.get(id)
  return p && p.picks.length === questions.length ? p : initialProgress(questions)
}

export function saveAskProgress(id: string, progress: AskProgress) {
  saved.set(id, progress)
}

/** Answered (or replaced): its progress goes. */
export function dropAskProgress(id: string) {
  saved.delete(id)
}

/** Tests: forget every form. */
export function resetAskProgress() {
  saved.clear()
}

/** The answer a pick stands for: the choice's text, or what was typed; "" when there's none yet. */
export function answerOf(q: AskQuestion, pick: AskPick, custom: string): string {
  if (pick === "custom") return custom.trim()
  return pick === null ? "" : (questionChoices(q)[pick] ?? "")
}

/** Every question's answer, in order. */
export const answersOf = (questions: readonly AskQuestion[], p: AskProgress) => questions.map((q, i) => answerOf(q, p.picks[i] ?? null, p.custom[i] ?? ""))

const FOCUS_EVENT = "box-yard:focus-ask"
/** A request nobody took by then (the task never showed) is dropped, so it can't steal focus later. */
const PENDING_MS = 5000
let pending: { taskId: string; at: number } | null = null

/**
 * Put the focus in a task's ask form, now if it's on screen or when it mounts (a notice's Answer opens the task
 * first). The form's own useAskFocus takes it.
 */
export function focusAsk(taskId: string) {
  pending = { taskId, at: Date.now() }
  window.dispatchEvent(new CustomEvent(FOCUS_EVENT, { detail: taskId }))
}

/** The form's half of focusAsk: `focus` runs when a request for `taskId` stands. */
export function takeAskFocus(taskId: string, focus: () => void): () => void {
  const take = () => {
    const request = pending
    if (!request || request.taskId !== taskId) return
    pending = null
    if (Date.now() - request.at <= PENDING_MS) focus()
  }
  take()
  const onFocus = (e: Event) => {
    if ((e as CustomEvent<string>).detail === taskId) take()
  }
  window.addEventListener(FOCUS_EVENT, onFocus)
  return () => window.removeEventListener(FOCUS_EVENT, onFocus)
}
