// What of a Captain's reply may show in its chat while it is still being written (Settings › Coordinator › Stream
// Captain replies). The stored reply is unchanged: it is still made from the whole message once it's written
// (server/captains.ts: takeFyiMarker, then parseNextSteps). The live text only ever holds back more than that:
//   - a bare "(no update)", which is never shown, while the reply could still be one;
//   - Box Yard's hidden blocks, `<!-- boxyard-… -->` (the next steps, the Coordinator FYI line) and a fenced
//     ```boxyard-next-steps block, from their first character, even when they arrive split across chunks.
// Anything held back while it could still turn out to be one of those shows as soon as it can't.

/** A Captain's whole reply when it has nothing to report: never shown (server/captains.ts NO_UPDATE). */
export const CAPTAIN_NO_UPDATE = "(no update)"

const FYI_MARKER = /<!--\s*boxyard-coordinator:\s*fyi\s*-->/gi
const HIDDEN_NAME = "boxyard-"
const FENCED_NAME = "boxyard-next-steps"

/** `a` is `b` so far, or more: `b` may still become it. */
const couldBe = (a: string, b: string) => a.startsWith(b) || b.startsWith(a)

/**
 * Where the text must stop showing for now: the first `<!--` that is (or may yet become) a `<!-- boxyard-…` comment,
 * a fence line that is (or may yet become) ```boxyard-next-steps, or a trailing `<`, `<!`, `<!-` that may start one.
 * Text.length when nothing is held.
 */
function holdFrom(text: string): number {
  let at = text.length
  // Comments: `<!--`, any whitespace, then the rest of the text up to its close.
  for (let i = text.indexOf("<!--"); i >= 0 && i < at; i = text.indexOf("<!--", i + 4)) {
    const rest = text.slice(i + 4).replace(/^\s+/, "")
    if (couldBe(rest.slice(0, HIDDEN_NAME.length).toLowerCase(), HIDDEN_NAME)) {
      at = i
      break
    }
  }
  // A comment's opener cut off at the end of the text so far.
  const tail = /<(?:!-?)?$/.exec(text)
  if (tail && tail.index < at) at = tail.index
  // Fence lines: up to three backticks at a line's start, then the language so far.
  const fence = /(^|\n)([ \t]*`{1,3}[ \t]*)([^\n]*)/g
  for (let m = fence.exec(text); m && m.index < at; m = fence.exec(text)) {
    const start = m.index + m[1]!.length
    const ticks = m[2]!.trim().length
    const lang = m[3]!
    const open = start + m[0].length - m[1]!.length === text.length // the line is still being written
    if (ticks === 3 ? (lang.toLowerCase().startsWith(FENCED_NAME) || (open && FENCED_NAME.startsWith(lang.toLowerCase()))) : open && !lang) {
      at = Math.min(at, start)
      break
    }
  }
  return at
}

/** The part of a reply written so far that may show now (see the top of this file). */
export function visibleReply(written: string): string {
  const text = written.replace(FYI_MARKER, "")
  const shown = text.slice(0, holdFrom(text)).replace(/^\s+/, "").trimEnd()
  // "(no update)" so far, or exactly: it may be the whole reply, which never shows.
  if (CAPTAIN_NO_UPDATE.startsWith(shown)) return ""
  return shown
}

/** One chunk of live text for the chat: added to what it shows, or (reset) in place of it. */
export interface StreamChunk {
  text: string
  reset: boolean
}

/**
 * One reply as it streams in: push each piece of its text as it comes, and send on what push returns. The visible
 * text only grows, so a chunk is normally the new end of it; `reset` replaces the chat's live text instead (the first
 * chunk after reset(), or the rare change that isn't an addition).
 */
export class CaptainStreamer {
  private written = ""
  private shown = ""
  private fresh = true

  /** A new block of text starts: the chat's live text starts over with its first chunk. */
  reset() {
    this.written = ""
    this.shown = ""
    this.fresh = true
  }

  /** What the chat shows now. */
  get text() {
    return this.shown
  }

  push(piece: string): StreamChunk | null {
    this.written += piece
    const next = visibleReply(this.written)
    if (next === this.shown) return null
    const grew = next.startsWith(this.shown)
    const chunk = { text: grew && !this.fresh ? next.slice(this.shown.length) : next, reset: this.fresh || !grew }
    this.shown = next
    this.fresh = false
    return chunk
  }
}
