// A task's several questions (ask_user's `questions`, shared/askQuestions.ts) as the ask card at the foot of its
// transcript (TaskView.tsx): one question at a time, each with the agent's default picked, its other options, and a
// box for an answer of Cody's own. Back and Next move between them keeping every answer ("2 of 5"); the last one's
// Send answers sends them all as one message to the task's session (POST /api/tasks/:id/answers).
//
// Keyboard: ↑/↓ move between the choices (a radio group), 1–9 pick one (the last number is "Your own answer"),
// Enter goes on (or sends), Shift+Enter goes back. Moving keeps the focus on the question on screen. Answers in
// progress stay in memory per task and ask (lib/askAnswers.ts), so leaving the task and coming back keeps them.
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { ChevronLeft, ChevronRight, MessageCircleQuestion, Send } from "lucide-react"
import { askKey, questionChoices, questionsIntro, type AskQuestion } from "../../../shared/askQuestions"
import { answerOf, answersOf, askProgressId, dropAskProgress, readAskProgress, saveAskProgress, takeAskFocus, type AskPick, type AskProgress } from "../lib/askAnswers"
import { useAnswerQuestions } from "../lib/queries"
import { focusComposer } from "../lib/chatSwitch"
import { ApiError } from "../lib/api"
import { LineIcon, Markdown, TimeAgo, cx } from "./ui"

/** The ask card's frame (TaskView.tsx's single question uses it too). */
export const ASK_CARD = "flex items-start gap-2.5 rounded-xl border border-amber-500/40 bg-amber-500/5 px-3 py-2.5 text-sm"

const FOCUS_RING = "focus-visible:ring-2 focus-visible:ring-yard-500/50 focus-visible:outline-none"
/** Back and Next: 36px drawn, 44px on a touch screen. No transition: the app has no motion but the working pulse. */
const NAV_BUTTON = cx(
  "inline-flex h-9 min-w-11 shrink-0 items-center justify-center gap-1 rounded-lg px-3 text-sm font-medium whitespace-nowrap pointer-coarse:h-11 disabled:cursor-not-allowed disabled:opacity-50",
  FOCUS_RING,
)

export const AskQuestions = memo(function AskQuestions({
  taskId,
  question,
  questions,
  askedAt,
}: {
  taskId: string
  /** The task's question: the text version of the ask, which starts with the agent's intro if it gave one. */
  question: string
  questions: readonly AskQuestion[]
  /** When it was asked (its transcript event), for the header's time. */
  askedAt: number | null
}) {
  const key = useMemo(() => askKey(questions), [questions])
  const intro = useMemo(() => questionsIntro(question, questions), [question, questions])
  const id = askProgressId(taskId, key)
  const [progress, setProgressState] = useState<AskProgress>(() => readAskProgress(id, questions))
  // Another ask (or task) in the same card: its own progress.
  const [shownId, setShownId] = useState(id)
  if (shownId !== id) {
    setShownId(id)
    setProgressState(readAskProgress(id, questions))
  }
  const setProgress = useCallback((next: AskProgress) => {
    saveAskProgress(id, next)
    setProgressState(next)
  }, [id])

  const answer = useAnswerQuestions(taskId)
  const [error, setError] = useState<string | null>(null)
  const total = questions.length
  const step = Math.min(progress.step, total - 1)
  const q = questions[step]!
  const choices = useMemo(() => questionChoices(q), [q])
  const pick = progress.picks[step] ?? null
  const custom = progress.custom[step] ?? ""
  const current = answerOf(q, pick, custom)
  const last = step === total - 1

  const base = useId()
  const name = `${base}-q${step}`
  const customId = `${base}-custom${step}`
  const hintId = `${base}-hint`
  const errorId = `${base}-error`
  const form = useRef<HTMLFormElement>(null)
  const customInput = useRef<HTMLInputElement>(null)
  /** Set when Cody moved between questions: the new one takes the focus once it's on screen (never on first show). */
  const moved = useRef(false)

  /** The focus on the question on screen: its picked choice, else its first (a radio group's own tab stop). */
  const focusStep = useCallback(() => {
    const el = form.current
    if (!el) return
    const target = el.querySelector<HTMLInputElement>('input[type="radio"]:checked') ?? el.querySelector<HTMLInputElement>('input[type="radio"]')
    target?.focus({ preventScroll: false })
  }, [])
  useEffect(() => {
    if (!moved.current) return
    moved.current = false
    focusStep()
  }, [step, focusStep])
  // A notice's Answer (focusAsk) asks for the focus here, as it asks for the box on a plain question.
  useEffect(() => takeAskFocus(taskId, focusStep), [taskId, focusStep])

  const choose = (next: AskPick) => {
    setError(null)
    const picks = progress.picks.slice()
    picks[step] = next
    setProgress({ ...progress, picks })
  }
  const type = (text: string) => {
    setError(null)
    const customs = progress.custom.slice()
    customs[step] = text
    const picks = progress.picks.slice()
    // Typing is choosing your own answer; clearing it again leaves that choice for the box to fill.
    if (text.trim()) picks[step] = "custom"
    setProgress({ ...progress, picks, custom: customs })
  }
  const go = (to: number) => {
    if (to < 0 || to >= total) return
    setError(null)
    moved.current = true
    setProgress({ ...progress, step: to })
  }
  const missing = () => setError(pick === "custom" ? "Type your answer, or pick one of the choices." : "Pick an answer, or type your own.")

  const submit = () => {
    if (answer.isPending) return
    if (!current) return missing()
    if (!last) return go(step + 1)
    const answers = answersOf(questions, progress)
    const blank = answers.findIndex((a) => !a)
    if (blank >= 0) {
      // Every answer is checked as Next goes, so this is only one left blank by going back and clearing it.
      moved.current = true
      setProgress({ ...progress, step: blank })
      return setError(`Question ${blank + 1} has no answer yet.`)
    }
    // mutateAsync, not mutate's callbacks: the card goes as soon as the task's question clears, and these still run.
    answer.mutateAsync({ key, answers }).then(
      () => {
        dropAskProgress(id)
        focusComposer(taskId)
      },
      (err: Error) => setError(err instanceof ApiError && err.status === 409 ? "These questions were answered or replaced meanwhile." : `Couldn't send the answers: ${err.message}`),
    )
  }

  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.defaultPrevented || e.nativeEvent.isComposing || e.altKey || e.ctrlKey || e.metaKey) return
    const target = e.target as HTMLElement
    const typing = target === customInput.current
    if (e.key === "Enter") {
      // A focused button does its own thing on Enter (Back goes back, Next goes on); Shift+Enter always goes back.
      if (target.tagName === "BUTTON" && !e.shiftKey) return
      e.preventDefault()
      if (e.shiftKey) go(step - 1)
      else submit()
      return
    }
    if (typing || e.shiftKey || !/^[1-9]$/.test(e.key)) return
    const n = Number(e.key) - 1
    if (n < choices.length) {
      e.preventDefault()
      choose(n)
      form.current?.querySelector<HTMLInputElement>(`input[type="radio"][value="${n}"]`)?.focus()
    } else if (n === choices.length) {
      e.preventDefault()
      choose("custom")
      customInput.current?.focus()
    }
  }

  return (
    <div role="group" aria-label="The agent asks" data-testid="pending-ask" data-questions={total} className={ASK_CARD}>
      <LineIcon icon={MessageCircleQuestion} className="h-4 w-4 text-amber-400" box="h-7!" />
      <div className="@container/ask min-w-0 flex-1">
        <div className="flex h-7 min-w-0 items-center gap-2 text-[11px] font-semibold text-amber-400">
          <span className="shrink-0">The agent asks</span>
          {askedAt !== null && (
            <span className="shrink-0 font-normal text-zinc-400 @max-[15rem]/ask:hidden">
              <TimeAgo ts={askedAt} />
            </span>
          )}
          {/* The legend says it for a screen reader, with the question. */}
          <span data-testid="ask-progress" aria-hidden className="ml-auto shrink-0 font-medium text-zinc-300 tabular-nums">
            {step + 1} of {total}
          </span>
        </div>
        {intro && (
          <div className="min-w-0 pb-1 text-xs leading-5 wrap-anywhere text-zinc-300 [&>.prose-chat>:first-child]:mt-0! [&>.prose-chat>:last-child]:mb-0!">
            <Markdown>{intro}</Markdown>
          </div>
        )}
        <form ref={form} noValidate onKeyDown={onKeyDown} onSubmit={(e) => { e.preventDefault(); submit() }} aria-describedby={hintId}>
          <fieldset key={step} data-testid="ask-question" data-step={step} className="min-w-0" aria-describedby={error ? errorId : undefined}>
            <legend className="float-left w-full min-w-0 pt-0.5 pb-2 leading-relaxed wrap-anywhere text-zinc-100 [&_.prose-chat>:first-child]:mt-0! [&_.prose-chat>:last-child]:mb-0!">
              <span className="sr-only">Question {step + 1} of {total}: </span>
              <Markdown>{q.question}</Markdown>
            </legend>
            <div className="clear-both space-y-1.5">
              {choices.map((text, i) => (
                <Choice key={i} name={name} value={String(i)} n={i + 1} checked={pick === i} onPick={() => choose(i)} badge={i === 0 && q.defaultAnswer ? "Default" : null}>
                  {text}
                </Choice>
              ))}
              <Choice name={name} value="custom" n={choices.length + 1} checked={pick === "custom"} onPick={() => choose("custom")} controls={customId}>
                Your own answer
              </Choice>
              <input
                ref={customInput}
                id={customId}
                data-testid="ask-custom"
                type="text"
                value={custom}
                onChange={(e) => type(e.target.value)}
                aria-label={`Your own answer to question ${step + 1}`}
                placeholder="Type your own answer"
                enterKeyHint={last ? "send" : "next"}
                autoComplete="off"
                maxLength={4000}
                className={cx(
                  "block h-9 w-full min-w-0 rounded-lg border bg-zinc-950 px-3 text-sm text-zinc-100 placeholder:text-zinc-500 pointer-coarse:h-11",
                  pick === "custom" ? "border-amber-500/60" : "border-zinc-800",
                  FOCUS_RING,
                )}
              />
            </div>
          </fieldset>
          {error && (
            <p id={errorId} role="alert" data-testid="ask-error" className="pt-2 text-xs text-red-300">
              {error}
            </p>
          )}
          <div className="flex min-w-0 flex-wrap items-center gap-2 pt-2.5">
            <button type="button" data-testid="ask-back" onClick={() => go(step - 1)} disabled={step === 0 || answer.isPending} className={cx(NAV_BUTTON, "bg-zinc-800 text-zinc-200 hover:bg-zinc-700 @max-[16rem]/ask:flex-1")}>
              <ChevronLeft className="h-4 w-4" aria-hidden />
              Back
            </button>
            <span id={hintId} className="min-w-0 flex-1 truncate text-[11px] text-zinc-500 pointer-coarse:hidden @max-[26rem]/ask:hidden">
              1–{choices.length + 1} to pick · Enter {last ? "sends" : "next"} · Shift+Enter back
            </span>
            <button
              type="submit"
              data-testid={last ? "ask-send" : "ask-next"}
              disabled={answer.isPending}
              className={cx(NAV_BUTTON, "ml-auto border border-amber-500/45 bg-amber-500/15 font-semibold text-amber-100 hover:bg-amber-500/25 @max-[16rem]/ask:ml-0 @max-[16rem]/ask:flex-1")}
            >
              {last ? (
                <>
                  <Send className="h-3.5 w-3.5" aria-hidden />
                  {answer.isPending ? "Sending…" : total === 1 ? "Send answer" : "Send answers"}
                </>
              ) : (
                <>
                  Next
                  <ChevronRight className="h-4 w-4" aria-hidden />
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
})

/** One choice: a 44px row, the whole row picks it. Its number is the key that picks it (not on touch screens). */
function Choice({
  name,
  value,
  n,
  checked,
  onPick,
  badge = null,
  controls,
  children,
}: {
  name: string
  value: string
  n: number
  checked: boolean
  onPick: () => void
  badge?: string | null
  controls?: string
  children: string
}) {
  return (
    <label
      data-testid="ask-choice"
      data-checked={checked || undefined}
      className={cx(
        "flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 focus-within:ring-2 focus-within:ring-yard-500/50",
        checked ? "border-amber-500/60 bg-amber-500/10 text-zinc-50" : "border-zinc-800 bg-zinc-950/60 text-zinc-200 hover:border-zinc-700",
      )}
    >
      <input type="radio" name={name} value={value} checked={checked} onChange={onPick} aria-controls={controls} className="h-4 w-4 shrink-0 accent-amber-400 focus-visible:outline-none" />
      <span className="min-w-0 flex-1 wrap-anywhere">
        {children}
        {badge && <span className="sr-only"> ({badge.toLowerCase()})</span>}
      </span>
      {badge && (
        <span aria-hidden className="shrink-0 rounded border border-amber-500/40 px-1.5 text-[11px] font-medium text-amber-300">
          {badge}
        </span>
      )}
      {n <= 9 && (
        <kbd aria-hidden className="shrink-0 font-sans text-[11px] text-zinc-500 tabular-nums pointer-coarse:hidden">
          {n}
        </kbd>
      )}
    </label>
  )
}
