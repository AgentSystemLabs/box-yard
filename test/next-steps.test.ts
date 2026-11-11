import { describe, expect, it } from "vitest"
import { NEXT_STEPS_META_KEY, parseNextSteps } from "../shared/nextSteps.js"
import { buildSelectionTaskPrompt } from "../web/src/lib/selectionTask.js"

describe("next-step parsing", () => {
  it("strips the hidden JSON block and returns up to four suggestions", () => {
    const parsed = parseNextSteps(`Done.\n\n<!-- boxyard-next-steps\n["Review it","Run tests","Open PR","Deploy","Ignore"]\n-->`)
    expect(parsed.content).toBe("Done.")
    expect(parsed.nextSteps).toEqual(["Review it", "Run tests", "Open PR", "Deploy"])
  })

  it("accepts line-based fallback blocks", () => {
    const parsed = parseNextSteps("Done.\n```boxyard-next-steps\n- Follow up\n- Ask for screenshots\n```")
    expect(parsed).toEqual({ content: "Done.", nextSteps: ["Follow up", "Ask for screenshots"] })
  })

  it("keeps a mid-reply mention of the marker and still reads the real block at the end", () => {
    const body = "The parser looks for `<!-- boxyard-next-steps` at the end.\n<!-- boxyard-next-steps is the marker -->\nMore text after it."
    const parsed = parseNextSteps(`${body}\n\n<!-- boxyard-next-steps\n["Fix it","Test it"]\n-->\n  \n`)
    expect(parsed).toEqual({ content: body, nextSteps: ["Fix it", "Test it"] })
  })

  it("leaves a reply untouched when it mentions the marker but has no real block", () => {
    const text = "Replies end with a `<!-- boxyard-next-steps [...] -->` comment.\n\nHere is the rest of the briefing, which must survive."
    expect(parseNextSteps(text)).toEqual({ content: text, nextSteps: [] })
    const tail = "Example:\n<!-- boxyard-next-steps\n[\"a\"]\n-->\nAnd the reply keeps going."
    expect(parseNextSteps(tail)).toEqual({ content: tail, nextSteps: [] })
  })

  it("only counts the last of several blocks", () => {
    const parsed = parseNextSteps(`Intro.\n<!-- boxyard-next-steps\n["Old"]\n-->\nMiddle.\n<!-- boxyard-next-steps\n["New one","New two"]\n-->`)
    expect(parsed).toEqual({ content: `Intro.\n<!-- boxyard-next-steps\n["Old"]\n-->\nMiddle.`, nextSteps: ["New one", "New two"] })
  })

  it("does not treat a marker mention inside the final line as a block", () => {
    const text = "Done. See <!-- boxyard-next-steps [\"x\"] -->"
    expect(parseNextSteps(text)).toEqual({ content: text, nextSteps: [] })
  })

  it("strips a malformed JSON block without inventing suggestions", () => {
    const parsed = parseNextSteps(`Done.\n\n<!-- boxyard-next-steps\n["Review it", "Run tests"\n-->`)
    expect(parsed).toEqual({ content: "Done.", nextSteps: [] })
  })

  it("returns the reply as-is when there is no block", () => {
    expect(parseNextSteps("Just a normal reply.\n")).toEqual({ content: "Just a normal reply.\n", nextSteps: [] })
    expect(parseNextSteps("")).toEqual({ content: "", nextSteps: [] })
  })

  it("accepts a single-line block on its own line", () => {
    expect(parseNextSteps(`Done.\n<!-- boxyard-next-steps ["A","B"] -->`)).toEqual({ content: "Done.", nextSteps: ["A", "B"] })
  })
})

describe("selection task prompt", () => {
  it("asks for a new task from the request and the highlighted text, and says where it was highlighted", () => {
    const prompt = buildSelectionTaskPrompt({
      source: {
        kind: "task",
        project: { id: "prj_site", name: "site" },
        task: { id: "task_123", title: "Fix nav", branch: "boxyard/fix-nav", prUrl: "https://github.com/acme/site/pull/4" },
      },
      selectedText: "The nav flickers on mobile.",
      instructions: "Make this a separate investigation.",
      place: { messageId: "tm_42", thread: { id: "thr_7", quote: "the nav\nbar" } },
      ownerName: "Ada",
    })
    expect(prompt.split("\n")[0]).toContain("Create a new task from Ada's request and the text Ada highlighted")
    // A task's goes to its project's Captain, which keeps it in the project.
    expect(prompt).toContain("It belongs in this project unless the request says otherwise.")
    expect(prompt).toContain("## The request\nMake this a separate investigation.")
    expect(prompt).toContain("Project: site (prj_site)")
    expect(prompt).toContain("In the transcript of the task: Fix nav (task_123)")
    expect(prompt).toContain("That task's branch: boxyard/fix-nav")
    expect(prompt).toContain("That task's pull request: https://github.com/acme/site/pull/4")
    expect(prompt).toContain("In a side thread (thr_7) about: “the nav bar”")
    expect(prompt).toContain("Message: tm_42")
    expect(prompt).toContain("## Highlighted text\n> The nav flickers on mobile.")
  })

  it("from the Coordinator's chat it leaves the project to the Coordinator, and says so when there's no request", () => {
    const prompt = buildSelectionTaskPrompt({ source: { kind: "orchestrator" }, selectedText: "Two lines\nof output", instructions: " " })
    expect(prompt).toContain("Put it in the project it belongs to.")
    expect(prompt).toContain("didn't write one: work out the task from the highlighted text.")
    expect(prompt).toContain("- Project: unknown")
    expect(prompt).toContain("> Two lines\n> of output")
  })

  it("uses the shared meta key expected by the UI", () => {
    expect(NEXT_STEPS_META_KEY).toBe("nextSteps")
  })
})
