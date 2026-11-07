// The tags in a chat's draft in colour: a "#project" in its project's colour, an "@runner" and a "!harness" each in
// their own (which words are tags: shared/runTargets.ts tagsIn). The textarea stays the real input, so the caret,
// selection, IME, undo, autocorrect and scrolling are all its own: while the draft holds a tag, the Composer makes its
// text transparent and this layer under it draws the same text in the same box, tags tinted. Nothing here may change
// a glyph's width or place (weight, padding, border, letter-spacing), or the two stop lining up: a tag that's only its
// part of the message's is marked with a dashed underline, which takes no room.
import { memo, useLayoutEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from "react"
import { cx } from "./ui"
import { useTiles } from "../lib/taskTiles"
import { PROJECT_COLOR_HEX, type ProjectColor } from "../../../shared/projectColors"
import type { TagKind, TextTag } from "../../../shared/runTargets"

/**
 * Each kind's colour, as a hex for the `.composer-tag` tint (styles.css). A project's is its own (shared/projectColors.ts),
 * so these two stay off that palette and the colours the app means something by: the brand yellow for where the tasks
 * run (the Where button lights up in it), violet for the harness. At the 400 shades and lighter they keep their
 * contrast on the composer's zinc-900 under the tint.
 */
export const TAG_COLOR: Record<Exclude<TagKind, "project">, string> = {
  runsOn: "#fbbf24",
  agent: "#c4b5fd",
}

/** A tag's colour: its kind's, or its project's (undefined until the project's colour is known: it's drawn plain). */
export function tagColor(tag: Pick<TextTag, "kind" | "target">, projects: ReadonlyMap<string, ProjectColor>): string | undefined {
  if (tag.kind !== "project") return TAG_COLOR[tag.kind]
  const color = projects.get(tag.target.value)
  return color ? PROJECT_COLOR_HEX[color] : undefined
}

/** The `.composer-tag` colours (styles.css): the text's, and its tint at 14%, which keeps every colour above 4.5:1. */
export function tagStyle(hex: string): CSSProperties {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  return { "--tag": hex, "--tag-tint": `rgb(${r} ${g} ${b} / 14%)` } as CSSProperties
}

/** `text` as text runs and tag spans. */
export function tagParts(text: string, tags: readonly TextTag[], color: (tag: TextTag) => string | undefined): ReactNode[] {
  const parts: ReactNode[] = []
  let at = 0
  tags.forEach((tag, i) => {
    const c = color(tag)
    if (!c) return
    if (tag.start > at) parts.push(text.slice(at, tag.start))
    parts.push(
      <span key={i} data-tag={tag.kind} data-part={tag.partial ? "" : undefined} className="composer-tag" style={tagStyle(c)}>
        {text.slice(tag.start, tag.end)}
      </span>,
    )
    at = tag.end
  })
  if (at < text.length) parts.push(text.slice(at))
  return parts
}

/**
 * `text` split at its newlines, each line with its own tags (counted from the line's start; a tag never holds a
 * newline). A line wraps on its own just as it does in the textarea, where a newline always breaks.
 */
export function tagLines(text: string, tags: readonly TextTag[]): { text: string; tags: TextTag[] }[] {
  const lines: { text: string; tags: TextTag[] }[] = []
  let start = 0
  let t = 0
  for (const line of text.split("\n")) {
    const end = start + line.length
    const own: TextTag[] = []
    for (; t < tags.length && tags[t]!.end <= end; t++) own.push({ ...tags[t]!, start: tags[t]!.start - start, end: tags[t]!.end - start })
    lines.push({ text: line, tags: own })
    start = end + 1
  }
  return lines
}

const sameTags = (a: readonly TextTag[], b: readonly TextTag[]) =>
  a.length === b.length &&
  a.every((t, i) => t.kind === b[i]!.kind && t.target.value === b[i]!.target.value && t.start === b[i]!.start && t.end === b[i]!.end && !t.partial === !b[i]!.partial)

/**
 * One line of the draft. Each is its own block, so a key redraws and lays out only its own line, however long the
 * draft (as one text, the whole layer was laid out again on every key). An empty line holds a zero-width space, or it
 * would take no height where the textarea shows one.
 */
const TagLine = memo(
  function TagLine({ text, tags, colors }: { text: string; tags: readonly TextTag[]; colors: ReadonlyMap<string, ProjectColor> }) {
    return <div>{text ? tagParts(text, tags, (tag) => tagColor(tag, colors)) : "\u200b"}</div>
  },
  (a, b) => a.text === b.text && a.colors === b.colors && sameTags(a.tags, b.tags),
)

/**
 * The draft drawn under the textarea (`source`), its tags in colour. `className` is the textarea's box metrics
 * (padding, text size, line height); it covers the textarea and follows its scroll. `scrolls`: the textarea shows a
 * scrollbar, so this keeps the same gutter (an invisible one) and wraps at the same width. In forced colours (Windows
 * contrast themes) the textarea's text shows instead, as colours are the system's there.
 */
export const ComposerTags = memo(function ComposerTags({
  text,
  tags,
  className,
  scrolls,
  source,
}: {
  text: string
  tags: readonly TextTag[]
  className: string
  scrolls: boolean
  source: RefObject<HTMLTextAreaElement | null>
}) {
  const { colors } = useTiles()
  const self = useRef<HTMLDivElement>(null)
  // Its scroll follows the textarea's: on every scroll, and on every change of text or gutter (a new tag shows the
  // layer already scrolled).
  useLayoutEffect(() => {
    const el = source.current
    const mirror = self.current
    if (!el || !mirror) return
    const follow = () => {
      if (mirror.scrollTop !== el.scrollTop) mirror.scrollTop = el.scrollTop
    }
    el.addEventListener("scroll", follow, { passive: true })
    return () => el.removeEventListener("scroll", follow)
  }, [source])
  useLayoutEffect(() => {
    const el = source.current
    const mirror = self.current
    if (el && mirror && mirror.scrollTop !== el.scrollTop) mirror.scrollTop = el.scrollTop
  })
  return (
    <div
      ref={self}
      aria-hidden
      data-testid="composer-tags"
      className={cx(
        className,
        "pointer-events-none absolute inset-0 whitespace-pre-wrap wrap-break-word text-zinc-100 select-none forced-colors:hidden",
        // The textarea's thin scrollbar, drawn in nothing: only its width matters.
        "[scrollbar-color:transparent_transparent] [scrollbar-width:thin]",
        scrolls ? "overflow-y-scroll" : "overflow-hidden",
      )}
    >
      {tagLines(text, tags).map((line, i) => (
        <TagLine key={i} text={line.text} tags={line.tags} colors={colors} />
      ))}
    </div>
  )
})
