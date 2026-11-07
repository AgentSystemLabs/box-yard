// @vitest-environment happy-dom
// A streaming reply's Markdown is parsed a settled block at a time (lib/liveMarkdown.ts): each chunk parses only the
// text from the last block that can still change, not the whole reply again. Every step must render exactly what a
// whole parse of the same text renders, however the text is cut into chunks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, Fragment, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import renderMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { PluggableList } from "unified"
import { liveMarkdown, type LiveMarkdown } from "../web/src/lib/liveMarkdown.js"
import { buildEntityIndex, MENTIONS, remarkEntityLinks } from "../web/src/lib/linkify.js"
import { Markdown } from "../web/src/components/ui.js"
import { keys } from "../web/src/lib/queries.js"
import type { Project, Task } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let parsed = 0
const render = (text: string, remarkPlugins: PluggableList, rehypePlugins: PluggableList) => {
  parsed += text.length
  return renderMarkdown({ children: text, remarkPlugins, rehypePlugins })
}
const html = (node: ReactNode) => renderToStaticMarkup(createElement(Fragment, null, node))

const index = buildEntityIndex({
  projects: [{ id: "prj_demo01", name: "box-yard", repo: "acme/box-yard" } as Project],
  tasks: [{ id: "task_demo01", projectId: "prj_demo01", title: "Fix the sidebar", status: "idle" } as Task],
})
const GFM: PluggableList = [remarkGfm]
const LINKED: PluggableList = [remarkGfm, [remarkEntityLinks, index, MENTIONS]]

/** Small deterministic PRNG, so a failing chunking can be replayed. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32)
}

/** Stream `text` in chunks of 1..max characters; after each, the live render must equal a whole parse. */
function stream(text: string, plugins: PluggableList, max: number, seed = 1) {
  const r = rng(seed)
  let state: LiveMarkdown | null = null
  for (let end = 0; end < text.length; ) {
    end = Math.min(text.length, end + 1 + Math.floor(r() * max))
    const part = text.slice(0, end)
    state = liveMarkdown(state, part, plugins, render)
    expect(html(state.node), `after ${JSON.stringify(part.slice(-40))} (${end} of ${text.length})`).toBe(html(renderMarkdown({ children: part, remarkPlugins: plugins })))
  }
  return state!
}

const DOCS: Record<string, string> = {
  "paragraphs and headings": "# Title\n\nFirst paragraph\nwith a soft break.\n\n## Second\n\nAnother paragraph.\n\n### Third\nText right under.",
  "a line that only starts like a heading": "Some text\n#hashtag keeps it one paragraph\n# But this is a heading\n\nAnd #12 is not.",
  "setext headings": "Title\n=====\n\nSub title\n---------\n\nText\n\nNot a list\n-\n\nafter",
  "loose and tight lists": "- one\n- two\n\n- three, now loose\n\nAfter\n\n1. a\n2. b\n\n3. c\n\n7. starts at seven\n8. eight\n\nEnd",
  "nested lists and continuations": "- item\n\n  continued paragraph\n\n  - nested\n  - nested two\n\n    deep paragraph\n\n- back out\n\n    indented code after a list?\n\nText",
  "indented blocks": "para\n\n   - three spaces\n\n    code block\n\n    still code\n\nend\n\n  ```js\n  const fenced = true\n  ```\n",
  "fenced code with blank lines": "Before\n\n```ts\nconst a = 1\n\n\nconst b = 2\n```\n\n~~~\n```\nnot a close\n~~~\n\nAfter the code",
  "tables": "Intro\n\n| Task | Status |\n| --- | --- |\n| task_demo01 | idle |\n| b | done |\n\nright after\n| x | y |\n| - | - |\n| 1 | 2 |\n\nDone.",
  "blockquotes and lazy lines": "> quote\nlazy continuation\n\n> second quote\n> > nested\n\nplain\n> starts a quote",
  "html blocks": "<details>\n<summary>More</summary>\n\nhidden **text**\n\n</details>\n\n<!-- a comment\n\nspanning blank lines -->\nafter\n\n<div>\nblock\n</div>\n\nend",
  "thematic breaks": "a\n\n---\n\n- - -\n\n* * *\n\nb\n***\nc",
  "task lists and autolinks": "- [ ] todo\n- [x] done https://example.com/x\n\nSee www.example.com and task_demo01 in box-yard, PR #12 and ~~struck~~ text.",
  "references and footnotes": "A [link][ref] and [another] one.\n\nMore text here[^1].\n\n[ref]: https://example.com\n[another]: /tasks/task_demo01\n\n[^1]: The note.\n\nAfter.",
  // Last: an unclosed fence runs to the end of the text.
  "an unclosed fence": "Text\n\n```bash\nunclosed\n\nstill code",
}

describe("liveMarkdown", () => {
  for (const [name, text] of Object.entries(DOCS)) {
    it(`renders ${name} like a whole parse after every chunk`, () => {
      // One character at a time hits every partial line; bigger chunks skip over some boundaries at once.
      stream(text, GFM, 1)
      for (const seed of [1, 2, 3]) stream(text, GFM, 12, seed)
    })
  }

  it("links entities and GitHub references like a whole parse", () => {
    for (const text of Object.values(DOCS)) stream(text, LINKED, 6)
  })

  it("parses only the tail of a long reply on each chunk", () => {
    const block = (i: number) =>
      [`### Part ${i}`, "Some prose about the task_demo01 change, with **bold** and `code`. ".repeat(3), "- one\n- two\n- three", "```ts\nconst x = 1\nconst y = 2\n```", "| a | b |\n| - | - |\n| 1 | 2 |"].join("\n\n")
    const text = Array.from({ length: 30 }, (_, i) => block(i)).join("\n\n")
    parsed = 0
    let state: LiveMarkdown | null = null
    const chunks = Math.ceil(text.length / 16)
    for (let i = 1; i <= chunks; i++) state = liveMarkdown(state, text.slice(0, i * 16), LINKED, render)
    // Parsing the whole text on every chunk would parse about chunks × length / 2 characters.
    const whole = (chunks * text.length) / 2
    expect(parsed).toBeLessThan(whole / 20)
    expect(html(state!.node)).toBe(html(renderMarkdown({ children: text, remarkPlugins: LINKED })))
  })

  it("keeps settled blocks' elements, so React skips them", () => {
    const a = liveMarkdown(null, "First\n\nSecond\n\nThi", GFM, render)
    const b = liveMarkdown(a, "First\n\nSecond\n\nThird\n\nFou", GFM, render)
    const c = liveMarkdown(b, "First\n\nSecond\n\nThird\n\nFourth", GFM, render)
    expect(b.settled.length).toBeGreaterThan(0)
    expect(c.settled[0]).toBe(b.settled[0])
    // Unchanged text (a re-render for another reason) parses nothing.
    expect(liveMarkdown(c, c.text, GFM, render)).toBe(c)
  })

  it("starts over when the text is replaced or the plugins change", () => {
    const a = liveMarkdown(null, "One\n\nTwo\n\nThree", GFM, render)
    const b = liveMarkdown(a, "One\n\nTwo\n\nThree\n\nFour", GFM, render)
    expect(b.settled.length).toBeGreaterThan(0)
    const other = liveMarkdown(b, "A new reply", GFM, render)
    expect(other.settled).toEqual([])
    expect(html(other.node)).toBe("<p>A new reply</p>")
    expect(liveMarkdown(b, b.text + "\n\nFive", LINKED, render).settled).toEqual([])
  })
})

describe("<Markdown live>", () => {
  let root: Root
  let host: HTMLElement
  let qc: QueryClient

  beforeEach(() => {
    vi.stubGlobal("fetch", () => new Promise(() => {}))
    qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    qc.setQueryData(keys.projects, [{ id: "prj_demo01", name: "box-yard", repo: "acme/box-yard" }])
    qc.setQueryData(keys.tasks, [{ id: "task_demo01", projectId: "prj_demo01", title: "Fix the sidebar", status: "idle" }])
    for (const k of [keys.schedules, keys.artifacts, keys.boxes]) qc.setQueryData(k, [])
    host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  })

  const show = (text: string, live: boolean) => act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(Markdown, { live }, text))))

  const streamIn = (text: string) => {
    for (let end = 0; end < text.length; ) {
      end = Math.min(text.length, end + 37)
      show(text.slice(0, end), true)
    }
  }
  const finished = (text: string) => {
    act(() => root.unmount())
    root = createRoot(host)
    show(text, false)
    return host.innerHTML
  }

  it("streams to the same DOM as the finished message", () => {
    const text = Object.values(DOCS).join("\n\n")
    streamIn(text)
    const streamed = host.innerHTML
    expect(streamed).toContain("<table")
    expect(streamed).toBe(finished(text))
  })

  it("keeps the nodes of blocks that settled", () => {
    const text = Object.entries(DOCS)
      .filter(([name]) => name !== "references and footnotes")
      .map(([, doc]) => doc)
      .join("\n\n")
    show(text.slice(0, 20), true)
    const heading = host.querySelector("h1")
    expect(heading?.textContent).toBe("Title")
    streamIn(text)
    // React didn't rebuild what had settled: the heading streamed first is the same node.
    expect(host.querySelector("h1")).toBe(heading)
  })

  it("keeps a block's node as it settles, and the blocks after it", () => {
    const paragraphs = () => [...host.querySelectorAll("p")]
    show("One\n\nTwo", true)
    show("One\n\nTwo\n\nThree", true)
    const before = paragraphs()
    expect(before.map((p) => p.textContent)).toEqual(["One", "Two", "Three"])
    // "One" settles here, so "Two" and "Three" are parsed again on their own: still the same nodes.
    show("One\n\nTwo\n\nThree\n\nFour", true)
    const after = paragraphs()
    expect(after.map((p) => p.textContent)).toEqual(["One", "Two", "Three", "Four"])
    after.slice(0, 3).forEach((p, i) => expect(p).toBe(before[i]))
  })
})
