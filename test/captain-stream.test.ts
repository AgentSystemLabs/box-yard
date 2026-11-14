import { describe, expect, it } from "vitest"
import { CaptainStreamer, visibleReply } from "../shared/captainStream.js"
import { parseNextSteps } from "../shared/nextSteps.js"
import { takeFyiMarker } from "../server/captainWake.js"

/** Feed a reply through the streamer in the given pieces; every text the chat showed along the way, in order. */
function stream(pieces: string[]): string[] {
  const s = new CaptainStreamer()
  let shown = ""
  const seen: string[] = []
  for (const piece of pieces) {
    const chunk = s.push(piece)
    if (!chunk) continue
    shown = chunk.reset ? chunk.text : shown + chunk.text
    expect(shown).toBe(s.text)
    seen.push(shown)
  }
  return seen
}

/** Every split of the text into one-character pieces, and a few random larger ones. */
function splits(text: string): string[][] {
  const out = [[...text], [text]]
  let seed = 7
  for (let n = 0; n < 20; n++) {
    const pieces: string[] = []
    for (let i = 0; i < text.length; ) {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      const len = 1 + (seed % 9)
      pieces.push(text.slice(i, i + len))
      i += len
    }
    out.push(pieces)
  }
  return out
}

/** What the chat stores for the whole reply today (server/captains.ts). */
function stored(text: string): string {
  return parseNextSteps(takeFyiMarker(text).text).content.trim()
}

const REPLIES = [
  "Started **Fix the login bug**. I'll report when it opens a PR.",
  "Done.\n\n<!-- boxyard-next-steps\n[\"Review the PR\",\"Merge it\"]\n-->",
  "Merged #12.\n<!-- boxyard-coordinator: fyi -->",
  "All green.\n\n```boxyard-next-steps\n- Open the preview\n- Ship it\n```\n",
  "Here's the diff:\n\n```ts\nconst a = 1 < 2\n```\n\nThat's it. <!-- a plain comment --> still shown",
  "Three tasks are working <!-- boxyard-coordinator: fyi --> and one is waiting.",
  "(no update) was the old reply; this one says more.",
  "a < b and c <- d",
]

describe("visibleReply", () => {
  it("never shows a hidden block or a bare (no update), whatever the chunking", () => {
    for (const reply of [...REPLIES, "(no update)", "(no update)\n<!-- boxyard-next-steps\n[]\n-->"]) {
      for (const pieces of splits(reply)) {
        for (const shown of stream(pieces)) {
          expect(shown).not.toMatch(/boxyard-/)
          expect(shown).not.toBe("(no update)")
          expect(stored(reply).startsWith(shown) || shown === "").toBe(true)
        }
      }
    }
  })

  it("ends on what the chat stores for the whole reply", () => {
    for (const reply of REPLIES.filter((r) => !r.includes("coordinator: fyi"))) {
      expect(visibleReply(reply)).toBe(stored(reply))
    }
    // The FYI marker leaves its spaces behind while streaming; the stored text tidies them.
    expect(visibleReply(REPLIES[2]!)).toBe("Merged #12.")
    expect(visibleReply("(no update)")).toBe("")
    expect(visibleReply("(no update)\n\n<!-- boxyard-next-steps\n[]\n-->")).toBe("")
  })

  it("holds an opener back only while it could still become a hidden block", () => {
    expect(visibleReply("Done. <")).toBe("Done.")
    expect(visibleReply("Done. <!-")).toBe("Done.")
    expect(visibleReply("Done. <!-- box")).toBe("Done.")
    expect(visibleReply("Done. <!-- note")).toBe("Done. <!-- note")
    expect(visibleReply("Done. <b")).toBe("Done. <b")
    expect(visibleReply("Done.\n```")).toBe("Done.")
    expect(visibleReply("Done.\n```boxyard")).toBe("Done.")
    expect(visibleReply("Done.\n```ts")).toBe("Done.\n```ts")
    expect(visibleReply("Done.\n``")).toBe("Done.")
    expect(visibleReply("Done.\n`x` is set")).toBe("Done.\n`x` is set")
    expect(visibleReply("(no upd")).toBe("")
    expect(visibleReply("(note)")).toBe("(note)")
  })

  it("streams additions, and starts over after reset()", () => {
    const s = new CaptainStreamer()
    expect(s.push("Hello")).toEqual({ text: "Hello", reset: true })
    expect(s.push(" wor")).toEqual({ text: " wor", reset: false })
    expect(s.push("ld <!")).toEqual({ text: "ld", reset: false })
    expect(s.push("-- boxyard-next-steps\n")).toBeNull()
    s.reset()
    expect(s.push("Second block")).toEqual({ text: "Second block", reset: true })
  })
})
