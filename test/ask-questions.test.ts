import { describe, expect, it } from "vitest"
import {
  MAX_OPTIONS,
  MAX_QUESTIONS,
  answerKind,
  answersProblem,
  askKey,
  formatAnswers,
  normalizeQuestions,
  questionChoices,
  questionsIntro,
  questionsProblem,
  questionsText,
  type AskQuestion,
} from "../shared/askQuestions.js"

const db: AskQuestion = { question: "Which database should it use?", defaultAnswer: "Postgres", options: ["SQLite", "MySQL"] }
const deploy: AskQuestion = { question: "Where should it deploy?", defaultAnswer: "Fly.io", options: ["Render"] }
const name: AskQuestion = { question: "What should the service be called?", defaultAnswer: "acme-settings", options: [] }

describe("ask_user questions: validation", () => {
  it("accepts the tool's own shape and stores it camel-cased", () => {
    expect(normalizeQuestions([{ question: " Which database should it use? ", default_answer: "Postgres", options: ["SQLite", " MySQL "] }])).toEqual([db])
  })

  it("drops blank questions and options, and options that repeat the default or each other", () => {
    const got = normalizeQuestions([
      { question: "  ", default_answer: "x" },
      { question: "Which database should it use?", default_answer: "Postgres", options: ["postgres", "SQLite", "", "sqlite", "MySQL", 42] },
    ])
    expect(got).toEqual([db])
  })

  it("caps the number of questions and options, and keeps a question without a default", () => {
    const many = Array.from({ length: MAX_QUESTIONS + 3 }, (_, i) => ({ question: `Q${i}`, options: Array.from({ length: MAX_OPTIONS + 4 }, (_, j) => `o${j}`) }))
    const got = normalizeQuestions(many)!
    expect(got).toHaveLength(MAX_QUESTIONS)
    expect(got[0]!.options).toHaveLength(MAX_OPTIONS)
    expect(got[0]!.defaultAnswer).toBeNull()
    expect(questionChoices(got[0]!)[0]).toBe("o0")
  })

  it("is null for anything that isn't a list of questions", () => {
    for (const raw of [undefined, null, "Which?", {}, [], [{ default_answer: "x" }]]) expect(normalizeQuestions(raw)).toBeNull()
  })

  it("explains what's wrong with a call, for the agent to fix it", () => {
    expect(questionsProblem([])).toMatch(/non-empty/)
    expect(questionsProblem([{ question: "Which?" }])).toMatch(/questions\[0\]\.default_answer is required/)
    expect(questionsProblem([{ question: "Which?", default_answer: "A", options: "B" }])).toMatch(/must be an array/)
    expect(questionsProblem([{ question: "Which?", default_answer: "A", options: Array(MAX_OPTIONS + 1).fill("x") }])).toMatch(/more than/)
    expect(questionsProblem(Array(MAX_QUESTIONS + 1).fill({ question: "Q", default_answer: "A" }))).toMatch(/at most/)
    expect(questionsProblem([{ question: "Which?", default_answer: "A", options: ["B"] }])).toBeNull()
  })
})

describe("ask_user questions: text", () => {
  it("writes the ask as text with each default and option, for notices, the Inbox and parent agents", () => {
    expect(questionsText("A few choices first.", [db, name])).toBe(
      "A few choices first.\n\n1. Which database should it use? (default: Postgres; or: SQLite / MySQL)\n2. What should the service be called? (default: acme-settings)",
    )
    expect(questionsText(null, [db])).toMatch(/^1 question:\n\n1\. Which database/)
  })

  it("gets the agent's intro back out of that text, and nothing when it gave none", () => {
    expect(questionsIntro(questionsText("A few choices first.", [db, deploy]), [db, deploy])).toBe("A few choices first.")
    expect(questionsIntro(questionsText(null, [db, deploy]), [db, deploy])).toBeNull()
    expect(questionsIntro("Something else entirely", [db])).toBeNull()
  })

  it("keys an ask by its questions", () => {
    expect(askKey([db, deploy])).toBe(askKey([{ ...db }, { ...deploy }]))
    expect(askKey([db, deploy])).not.toBe(askKey([db, { ...deploy, defaultAnswer: "Render" }]))
  })
})

describe("ask_user questions: answers", () => {
  it("tells a default, another option and an answer of one's own apart", () => {
    expect(answerKind(db, "Postgres")).toBe("default")
    expect(answerKind(db, "MySQL")).toBe("option")
    expect(answerKind(db, "DuckDB")).toBe("custom")
  })

  it("wants one non-empty answer per question", () => {
    expect(answersProblem([db, deploy], ["Postgres"])).toMatch(/Expected 2 answers/)
    expect(answersProblem([db, deploy], ["Postgres", "  "])).toMatch(/Question 2 has no answer/)
    expect(answersProblem([db], [7])).toMatch(/Question 1/)
    expect(answersProblem([db, deploy], ["Postgres", "Render"])).toBeNull()
  })

  it("pairs each question with its answer in one message, marking defaults and typed answers", () => {
    expect(formatAnswers([db, deploy, name], ["Postgres", "Render", "settings-api"])).toBe(
      [
        "My answers to your 3 questions:",
        "",
        "1. Which database should it use?",
        "   - Postgres (your default)",
        "2. Where should it deploy?",
        "   - Render",
        "3. What should the service be called?",
        "   - settings-api (my own answer)",
      ].join("\n"),
    )
  })

  it("keeps a multi-line answer inside its bullet, and says 'answer' for one question", () => {
    const text = formatAnswers([name], ["first line\n\nsecond line  "])
    expect(text).toBe("My answer to your question:\n\n1. What should the service be called?\n   - first line\n\n     second line (my own answer)")
  })
})
