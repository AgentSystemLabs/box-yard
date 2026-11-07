// Markdown that grows while it streams in (a reply arriving a few words at a time), parsed a settled block at a time.
// Parsing the whole text again on every chunk costs time in proportion to its length, so a long reply got slower to
// stream the longer it got. Instead, the blocks that can't change any more stay parsed and rendered (the same React
// elements, so React skips them too), and each chunk parses only the text from the last of them on.
//
// Why a block can't change: Markdown builds blocks line by line, and a top-level block closes for good when a line
// starts the next one. Only the open, last block can still become something else (a paragraph a heading or a table,
// a tight list a loose one). That holds once the next block's first line has ended: a line still arriving can turn
// out to continue the block above ("#" starts a heading, "#tag" doesn't). Link reference definitions and footnotes
// reach across blocks, so text with one ("]:") is parsed whole. Pure, so it is unit tested against whole parses.
import { cloneElement, createElement, Fragment, isValidElement, type ReactNode } from "react"
import type { Root } from "hast"
import type { PluggableList } from "unified"

/** Renders a piece of Markdown with these remark and rehype plugins (react-markdown with the chat's components). */
export type RenderMarkdown = (text: string, remarkPlugins: PluggableList, rehypePlugins: PluggableList) => ReactNode

export interface LiveMarkdown {
  text: string
  plugins: PluggableList
  /** The settled text's top-level blocks, rendered, with the newlines between them. */
  settled: ReactNode[]
  /** Where the tail, the text still parsed on every chunk, starts. */
  from: number
  /** Where each of the tail's top-level blocks started in the last parse (-1: unknown). */
  starts: number[]
  /** The whole text, rendered. */
  node: ReactNode[]
}

/** A line of indented code starts with four columns of space. */
const INDENTED = /^(?: {0,3}\t| {4})/

/** The last parse's top level: where each block started (-1: unknown), or null for a newline between two. */
let noted: (number | null)[] = []
/** rehype plugin: note where each top-level block starts. */
const noteBlocks = () => (tree: Root) => {
  noted = tree.children.map((c) => (c.type === "text" && !c.position ? null : (c.position?.start.offset ?? -1)))
}
const NOTE_BLOCKS: PluggableList = [noteBlocks]

/**
 * Render `text`, reusing what `prev` (the render of an earlier, shorter version of it) already parsed when the text
 * only grew. Returns the state to pass back with the next chunk; `node` is what to show.
 */
export function liveMarkdown(prev: LiveMarkdown | null, text: string, plugins: PluggableList, render: RenderMarkdown): LiveMarkdown {
  if (prev && prev.text === text && prev.plugins === plugins) return prev
  // Otherwise start over: a new reply, other plugins (an entity was added or renamed), or a definition.
  const grew = prev !== null && prev.plugins === plugins && text.startsWith(prev.text) && !text.includes("]:")
  const settled = grew ? prev.settled.slice() : []
  let from = grew ? prev.from : 0
  if (grew) {
    // The last block whose first line had ended in the text it was parsed from: every block before it is final.
    let cut = from
    // Whether the block before this one may settle: there is one, and it isn't indented code.
    let settles = false
    for (const start of prev.starts) {
      const line = prev.text.lastIndexOf("\n", start - 1) + 1
      // The parser (micromark) carries state across indented code: it ends one at a blank line after a list, and reads
      // a list right after one as a paragraph. Never cut next to one (Claude fences its code anyway).
      const code = start < 0 || INDENTED.test(prev.text.slice(line, line + 4))
      if (settles && !code) {
        if (prev.text.indexOf("\n", start) < 0) break
        // Cut at the start of its line, so the block keeps its indentation.
        if (/^[ \t]*$/.test(prev.text.slice(line, start))) cut = line
      }
      settles = !code
    }
    if (cut > from) {
      settled.push(...blocks(text.slice(from, cut), from, plugins, render).nodes)
      from = cut
    }
  }
  const tail = blocks(text.slice(from), from, plugins, render)
  return { text, plugins, settled, from, starts: tail.starts, node: [...settled, ...tail.nodes] }
}

/**
 * The top-level blocks of `text`, which starts at `from` in the whole text, rendered and each keyed by where it starts
 * there. So a block keeps its key, and React its DOM, as it moves from the tail to the settled part.
 */
function blocks(text: string, from: number, plugins: PluggableList, render: RenderMarkdown) {
  noted = []
  const root = render(text, plugins, NOTE_BLOCKS)
  const top = isValidElement<{ children?: ReactNode }>(root) ? root.props.children : undefined
  const list = top === undefined ? [] : Array.isArray(top) ? (top as ReactNode[]) : [top]
  const at = noted.map((s) => (s === null || s < 0 ? s : s + from))
  // The newline a whole parse puts between two blocks, here between this part and the one before.
  const nodes: ReactNode[] = from > 0 ? ["\n"] : []
  // react-markdown renders each top-level node as one child: an element for a block, a string for a newline or HTML.
  if (list.length === at.length && list.every((c, i) => (at[i] === null ? typeof c === "string" : at[i]! >= 0 && (isValidElement(c) || typeof c === "string")))) {
    list.forEach((c, i) => nodes.push(isValidElement(c) ? cloneElement(c, { key: `b${at[i]}` }) : c))
  } else nodes.push(createElement(Fragment, { key: `s${from}` }, root))
  return { nodes, starts: at.filter((s): s is number => s !== null) }
}
