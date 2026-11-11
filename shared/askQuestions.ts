// Several questions in one ask (ask_user's `questions`, runner/box-runner.mjs). The agent gives each one its default
// answer and the other options; Cody answers them one at a time in the task's ask card (web AskQuestions.tsx), where
// each also takes an answer of their own, and submits them together. The answers go back to the agent as one message
// (formatAnswers), the same way a typed answer does. The task's `question` keeps a text version of the ask
// (questionsText) for everything that only reads text: notices, the Inbox, notifications, the Coordinator, a parent.

/** One question of a multi-question ask, as stored on the task (Task.questions). */
export interface AskQuestion {
  /** The question, in Markdown. */
  question: string
  /** The answer picked until Cody picks another: the agent's recommendation. Null: none pre-selected. */
  defaultAnswer: string | null
  /** The other answers to pick from, after the default. Cody can always type an answer of their own. */
  options: string[]
}

/** How an answer was given: the default kept, another option picked, or typed. */
export type AnswerKind = "default" | "option" | "custom"

export const MAX_QUESTIONS = 10
/** Other options per question: with the default that's 8 choices, and "Your own answer" is the 9th (keys 1–9). */
export const MAX_OPTIONS = 7
export const MAX_QUESTION_TEXT = 2000
export const MAX_OPTION_TEXT = 500
export const MAX_ANSWER_TEXT = 4000

const clean = (v: unknown): string => (typeof v === "string" ? v.trim() : "")
const same = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase()

/**
 * The questions an ask_user event carries, cleaned up: blank questions and options dropped, options that repeat the
 * default or each other dropped, lengths and counts capped. Null when nothing usable is left (it's a plain ask then).
 * Accepts the tool's own names (`default_answer`) as well as the stored ones, since the event comes from the runner.
 */
export function normalizeQuestions(raw: unknown): AskQuestion[] | null {
  if (!Array.isArray(raw)) return null
  const out: AskQuestion[] = []
  for (const item of raw) {
    if (out.length >= MAX_QUESTIONS) break
    const q = typeof item === "string" ? { question: item } : item && typeof item === "object" ? (item as Record<string, unknown>) : null
    const question = clean(q?.question).slice(0, MAX_QUESTION_TEXT)
    if (!question) continue
    const given = clean(q?.defaultAnswer ?? q?.default_answer ?? q?.default).slice(0, MAX_OPTION_TEXT)
    const options: string[] = []
    for (const o of Array.isArray(q?.options) ? q.options : []) {
      const text = clean(o).slice(0, MAX_OPTION_TEXT)
      if (!text || (given && same(text, given)) || options.some((x) => same(x, text))) continue
      options.push(text)
      if (options.length >= MAX_OPTIONS) break
    }
    out.push({ question, defaultAnswer: given || null, options })
  }
  return out.length ? out : null
}

/**
 * What can be wrong with ask_user's `questions` as the agent passed them, for the tool's error (null: fine). Mirrors
 * the runner's own check (runner/box-runner.mjs askProblem), which can't import this file.
 */
export function questionsProblem(raw: unknown): string | null {
  if (!Array.isArray(raw) || !raw.length) return "questions must be a non-empty array"
  if (raw.length > MAX_QUESTIONS) return `at most ${MAX_QUESTIONS} questions per ask`
  for (const [i, item] of raw.entries()) {
    const q = item && typeof item === "object" ? (item as Record<string, unknown>) : null
    if (!clean(q?.question)) return `questions[${i}].question is required`
    if (!clean(q?.default_answer ?? q?.defaultAnswer ?? q?.default)) return `questions[${i}].default_answer is required: your recommended answer, pre-selected`
    if (q?.options !== undefined && !Array.isArray(q.options)) return `questions[${i}].options must be an array of strings`
    if (Array.isArray(q?.options) && q.options.length > MAX_OPTIONS) return `questions[${i}] has more than ${MAX_OPTIONS} options`
  }
  return null
}

/** The choices shown for a question, in order: its default first, then the other options. */
export function questionChoices(q: AskQuestion): string[] {
  return q.defaultAnswer ? [q.defaultAnswer, ...q.options] : [...q.options]
}

/**
 * The ask as text, for the task's `question`: the intro (ask_user's `question`, if any), then each question with its
 * default and options, so whoever reads only text (a parent agent, the Coordinator, a notification) can answer it.
 */
export function questionsText(intro: string | null, questions: readonly AskQuestion[]): string {
  const lines = questions.map((q, i) => {
    const head = `${i + 1}. ${oneLine(q.question)}`
    const choices = [q.defaultAnswer ? `default: ${oneLine(q.defaultAnswer)}` : "", q.options.length ? `or: ${q.options.map(oneLine).join(" / ")}` : ""].filter(Boolean)
    return choices.length ? `${head} (${choices.join("; ")})` : head
  })
  const lead = intro?.trim() || `${questions.length} ${questions.length === 1 ? "question" : "questions"}:`
  return `${lead}\n\n${lines.join("\n")}`
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim()

/**
 * A stable key for one ask's questions: the answer form keeps its answers under it, and the answer endpoint refuses
 * answers to questions that were since replaced (FNV-1a over the questions as JSON).
 */
export function askKey(questions: readonly AskQuestion[]): string {
  const text = JSON.stringify(questions.map((q) => [q.question, q.defaultAnswer, q.options]))
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/** Which of a question's kinds an answer is: its default, another of its options, or typed. */
export function answerKind(q: AskQuestion, answer: string): AnswerKind {
  const a = answer.trim()
  if (q.defaultAnswer && a === q.defaultAnswer) return "default"
  return q.options.includes(a) ? "option" : "custom"
}

/** What's wrong with `answers` to `questions` (null: fine): one non-empty answer per question, none too long. */
export function answersProblem(questions: readonly AskQuestion[], answers: unknown): string | null {
  if (!Array.isArray(answers) || answers.length !== questions.length) return `Expected ${questions.length} ${questions.length === 1 ? "answer" : "answers"}`
  for (const [i, a] of answers.entries()) {
    if (typeof a !== "string" || !a.trim()) return `Question ${i + 1} has no answer`
    if (a.length > MAX_ANSWER_TEXT) return `The answer to question ${i + 1} is longer than ${MAX_ANSWER_TEXT} characters`
  }
  return null
}

const KIND_MARK: Record<AnswerKind, string> = { default: " (your default)", option: "", custom: " (my own answer)" }

/**
 * The answers as the one message the agent gets: each question with its answer as a bullet under it, marked when
 * it's the default or typed. A multi-line answer's later lines are indented so they stay inside that bullet.
 */
export function formatAnswers(questions: readonly AskQuestion[], answers: readonly string[]): string {
  const items = questions.map((q, i) => {
    const answer = (answers[i] ?? "").trim()
    const said = answer.split("\n").map((line, j) => (j && line.trim() ? `     ${line}` : line.trimEnd())).join("\n")
    return `${i + 1}. ${oneLine(q.question)}\n   - ${said}${KIND_MARK[answerKind(q, answer)]}`
  })
  return `${questions.length === 1 ? "My answer to your question" : `My answers to your ${questions.length} questions`}:\n\n${items.join("\n")}`
}
