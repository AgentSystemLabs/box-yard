import { describe, expect, it } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import {
  buildEntityIndex,
  entityLookupsKey,
  followAppLink,
  githubRef,
  isExternal,
  linkTarget,
  MENTIONS,
  newLookups,
  refForHref,
  remarkEntityLinks,
  shortGithubLabel,
  shortShas,
  splitText,
  toolMentions,
  type EntityIndex,
  type RepoScope,
} from "../web/src/lib/linkify.js"
import { createdId } from "../server/orchestrator.js"
import type { Artifact, BoxInfo, Project, Schedule, Task } from "../shared/types.js"

const project = { id: "prj_demo01", name: "box-yard", repo: "acme/box-yard" } as Project
const tasks = [
  { id: "task_5e6f7a8b9c0d", projectId: "prj_demo01", title: "Inbox: mark card as reviewed", status: "working" },
  { id: "task_aaaaaaaaaaaa", projectId: "prj_demo01", title: "Same title", status: "done" },
  { id: "task_bbbbbbbbbbbb", projectId: "prj_demo01", title: "Same title", status: "idle" },
] as Task[]
const schedules = [{ id: "sch_0123456789ab", name: "Morning digest", cron: "0 9 * * *", enabled: true }] as Schedule[]
const artifacts = [{ id: "art_4c5d6e7f8a9b", title: "Architecture", filename: "arch.html", url: "/artifacts/art_4c5d6e7f8a9b/arch.html" }] as Artifact[]
const boxes = [{ id: "local-1a2b3c4d", status: "ready", residentTasks: ["task_5e6f7a8b9c0d"] }] as BoxInfo[]

const index = buildEntityIndex({ tasks, projects: [project], schedules, artifacts, boxes }, (s) => s.toUpperCase())

function render(md: string, idx: EntityIndex = index) {
  return renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, [remarkEntityLinks, idx]] }, md))
}

const anchors = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1])

describe("buildEntityIndex", () => {
  it("routes each kind to its page with a hover hint", () => {
    expect(index.byId.get("task_5e6f7a8b9c0d")).toMatchObject({ href: "/tasks/task_5e6f7a8b9c0d", hint: "Inbox: mark card as reviewed · WORKING · box-yard" })
    expect(index.byId.get("prj_demo01")).toMatchObject({ href: "/projects/prj_demo01", hint: "Project: box-yard (acme/box-yard)" })
    expect(index.byId.get("sch_0123456789ab")?.href).toBe("/schedules#sch_0123456789ab")
    expect(index.byId.get("art_4c5d6e7f8a9b")?.href).toBe("/artifacts/art_4c5d6e7f8a9b/arch.html")
    expect(index.byId.get("local-1a2b3c4d")).toMatchObject({ href: "/boxes#local-1a2b3c4d", hint: "Box · ready · 1 task" })
  })

  it("only indexes titles exactly one task has", () => {
    expect(index.byTitle.has("Inbox: mark card as reviewed")).toBe(true)
    expect(index.byTitle.has("Same title")).toBe(false)
  })
})

describe("splitText", () => {
  it("splits known ids out of text and leaves unknown ones", () => {
    const parts = splitText("see task_5e6f7a8b9c0d and task_ffffffffffff, box local-1a2b3c4d.", index)
    expect(parts.map((p) => [p.text, p.ref?.kind])).toEqual([
      ["see ", undefined],
      ["task_5e6f7a8b9c0d", "task"],
      [" and task_ffffffffffff, box ", undefined],
      ["local-1a2b3c4d", "box"],
      [".", undefined],
    ])
  })

  it("needs word boundaries around ids", () => {
    expect(splitText("xtask_5e6f7a8b9c0d task_5e6f7a8b9c0d-2", index).every((p) => !p.ref)).toBe(true)
  })

  it("links artifact paths without trailing punctuation", () => {
    const parts = splitText("Open /artifacts/art_4c5d6e7f8a9b/arch.html.", index)
    expect(parts[1]).toMatchObject({ text: "/artifacts/art_4c5d6e7f8a9b/arch.html", ref: { hint: "Artifact: Architecture" } })
    expect(parts[2]?.text).toBe(".")
  })
})

describe("remarkEntityLinks", () => {
  it("links ids in plain text", () => {
    const html = render("Started task_5e6f7a8b9c0d in prj_demo01.")
    expect(anchors(html)).toEqual(["/tasks/task_5e6f7a8b9c0d", "/projects/prj_demo01"])
    expect(html).toContain('data-entity="task"')
  })

  it("links ids inside inline code, keeping the code span", () => {
    const html = render("**Inbox: mark card as reviewed** (`task_5e6f7a8b9c0d`)")
    expect(html).toContain('<a href="/tasks/task_5e6f7a8b9c0d" data-entity="task"><code>task_5e6f7a8b9c0d</code></a>')
  })

  it("leaves code spans with more than an id alone", () => {
    expect(anchors(render("`git checkout task_5e6f7a8b9c0d`"))).toEqual([])
  })

  it("links ids in table cells", () => {
    const html = render("| Task | Id |\n| --- | --- |\n| Inbox | `task_5e6f7a8b9c0d` |\n| Digest | sch_0123456789ab |")
    expect(html).toContain("<table>")
    expect(anchors(html)).toEqual(["/tasks/task_5e6f7a8b9c0d", "/schedules#sch_0123456789ab"])
  })

  it("keeps unknown ids as plain text", () => {
    const html = render("Gone: task_ffffffffffff and `prj_nothere99`")
    expect(anchors(html)).toEqual([])
    expect(html).toContain("task_ffffffffffff")
  })

  it("does not link inside existing links", () => {
    const html = render("[task_5e6f7a8b9c0d is **Inbox: mark card as reviewed**](/tasks/task_5e6f7a8b9c0d) and [`prj_demo01`](/projects/prj_demo01)")
    expect(anchors(html)).toEqual(["/tasks/task_5e6f7a8b9c0d", "/projects/prj_demo01"])
    expect(html.match(/<a /g)).toHaveLength(2)
  })

  it("does not link inside fenced code", () => {
    expect(anchors(render("```\ntask_5e6f7a8b9c0d\n```"))).toEqual([])
  })

  it("links bold titles only when unambiguous", () => {
    const html = render("**Inbox: mark card as reviewed** and **Same title**")
    expect(anchors(html)).toEqual(["/tasks/task_5e6f7a8b9c0d"])
    expect(html).toContain("<strong>Same title</strong>")
  })

  it("does nothing with an empty cache except artifact paths", () => {
    const empty = buildEntityIndex({})
    expect(anchors(render("task_5e6f7a8b9c0d /artifacts/art_x12345/a.txt", empty))).toEqual(["/artifacts/art_x12345/a.txt"])
  })
})

// The Markdown cache keeps a message parsed for one index under the next when this key comes out the same (ui.tsx).
describe("entityLookupsKey", () => {
  const build = (lists: Parameters<typeof buildEntityIndex>[0]) => buildEntityIndex({ tasks, projects: [project], schedules, artifacts, boxes, ...lists })
  const task = (id: string, title: string) => ({ id, projectId: "prj_demo01", title, status: "idle" }) as Task
  const box = (id: string) => ({ id, status: "ready", residentTasks: [] }) as unknown as BoxInfo
  const game = { id: "prj_ktc0000001", name: "keep-the-castle", repo: "acme/keep-the-castle" } as Project
  const parse = (md: string, idx: EntityIndex, repo: RepoScope) => {
    const lookups = newLookups()
    const html = renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, [remarkEntityLinks, idx, repo, lookups]] }, md))
    return { html, lookups }
  }
  const texts = [
    "Working on task_5e6f7a8b9c0d and **Inbox: mark card as reviewed** in box local-1a2b3c4d.",
    "See /artifacts/art_4c5d6e7f8a9b/arch.html, `sch_0123456789ab` and [the task](/tasks/task_5e6f7a8b9c0d).",
    "**Ship the new thing** next, then task_new000000001 on box local-9z9z9z9z.",
    "- box-yard PR #12 is merged\n- keep-the-castle #5 too, see [it](/projects/prj_ktc0000001)",
    "Nothing to link here, just `code` and **bold**.",
  ]
  const unrelated: [string, EntityIndex][] = [
    ["a task added", build({ tasks: [...tasks, task("task_other0000001", "Something else")] })],
    ["a task renamed", build({ tasks: tasks.map((t, i) => (i === 1 ? { ...t, title: "Renamed" } : t)) })],
    ["an artifact added", build({ artifacts: [...artifacts, { id: "art_000000000002", title: "Notes", filename: "n.md", url: "/artifacts/art_000000000002/n.md" } as Artifact] })],
    ["a box added", build({ boxes: [...boxes, box("local-77777777")] })],
    ["a task's status changed", build({ tasks: tasks.map((t, i) => (i === 0 ? { ...t, status: "done" } : t)) })],
  ]
  const related: [string, EntityIndex, number][] = [
    ["a task it mentions added", build({ tasks: [...tasks, task("task_new000000001", "New")] }), 2],
    ["a task with its bold text as title added", build({ tasks: [...tasks, task("task_ship00000001", "Ship the new thing")] }), 2],
    ["its bold title made ambiguous", build({ tasks: [...tasks, task("task_dup000000001", "Inbox: mark card as reviewed")] }), 0],
    ["a box it mentions added", build({ boxes: [...boxes, box("local-9z9z9z9z")] }), 2],
    ["a box it mentions gone", build({ boxes: [] }), 0],
    ["a schedule it mentions gone", build({ schedules: [] }), 1],
  ]

  it.each([null, "acme/box-yard", MENTIONS])("never says the same for an index that links the text differently (repo %s)", (repo) => {
    for (const [, next] of [...unrelated, ...related, ["a project with a repo it names added", build({ projects: [project, game] })] as const]) {
      for (const text of texts) {
        const before = parse(text, index, repo)
        const same = entityLookupsKey(before.lookups, next) === entityLookupsKey(before.lookups, index)
        if (same) expect(parse(text, next, repo).html).toBe(before.html)
      }
    }
  })

  it("says the same when an entity the text doesn't mention is added, renamed or changed", () => {
    for (const [what, next] of unrelated) {
      for (const text of texts) {
        const { lookups } = parse(text, index, null)
        expect(entityLookupsKey(lookups, next), `${what}: ${text}`).toBe(entityLookupsKey(lookups, index))
      }
    }
  })

  it("changes for the text that mentions what changed, and only for it", () => {
    for (const [what, next, mentioned] of related) {
      for (const [i, text] of texts.entries()) {
        const { lookups, html } = parse(text, index, null)
        const changed = entityLookupsKey(lookups, next) !== entityLookupsKey(lookups, index)
        expect(changed, `${what}: ${text}`).toBe(i === mentioned)
        if (changed) expect(parse(text, next, null).html).not.toBe(html)
      }
    }
  })

  it("picks a Coordinator reply's repos again when a project it names gets one", () => {
    const next = build({ projects: [project, game] })
    const { lookups, html } = parse(texts[3]!, index, MENTIONS)
    expect(entityLookupsKey(lookups, next)).not.toBe(entityLookupsKey(lookups, index))
    expect(anchors(parse(texts[3]!, next, MENTIONS).html)).toContain("https://github.com/acme/keep-the-castle/issues/5")
    expect(anchors(html)).not.toContain("https://github.com/acme/keep-the-castle/issues/5")
    // Text with a repo of its own doesn't care.
    const own = parse(texts[3]!, index, "acme/box-yard").lookups
    expect(entityLookupsKey(own, next)).toBe(entityLookupsKey(own, index))
  })
})

describe("links", () => {
  it("classifies hrefs", () => {
    expect(linkTarget("/tasks/task_1")).toEqual({ kind: "app", href: "/tasks/task_1" })
    expect(linkTarget("http://yard.test/projects/p?tab=notes", "http://yard.test")).toEqual({ kind: "app", href: "/projects/p?tab=notes" })
    expect(linkTarget("/artifacts/art_1/a.html").kind).toBe("file")
    expect(linkTarget("https://github.com/x/y").kind).toBe("external")
    expect(linkTarget("//evil.test/x").kind).toBe("external")
  })

  it("treats only Box Yard's own origin as in-app", () => {
    const origin = "http://yard.test"
    expect(linkTarget("https://github.com/acme/box-yard/pull/66", origin)).toEqual({ kind: "external", href: "https://github.com/acme/box-yard/pull/66" })
    expect(linkTarget("http://yard.test", origin)).toEqual({ kind: "app", href: "/" })
    expect(linkTarget("http://yard.test?tab=recent", origin)).toEqual({ kind: "app", href: "/?tab=recent" })
    expect(linkTarget("http://YARD.test/tasks/task_1", origin)).toEqual({ kind: "app", href: "/tasks/task_1" })
    expect(linkTarget("http://yard.test/artifacts/art_1/a.html", origin)).toEqual({ kind: "file", href: "/artifacts/art_1/a.html" })
    // Look-alike hosts and other ports are other sites.
    expect(linkTarget("http://yard.test.evil/tasks/task_1", origin).kind).toBe("external")
    expect(linkTarget("http://yard.test:4051/", origin).kind).toBe("external")
    expect(linkTarget("https://yard.test/tasks/task_1", origin).kind).toBe("external")
  })

  it("finds the entity behind an in-app href", () => {
    expect(refForHref("/tasks/task_5e6f7a8b9c0d", index)?.kind).toBe("task")
    expect(refForHref("/projects/prj_demo01?tab=schedules", index)?.kind).toBe("project")
    expect(refForHref("/schedules#sch_0123456789ab", index)?.kind).toBe("schedule")
    expect(refForHref("/boxes#local-1a2b3c4d", index)?.kind).toBe("box")
    expect(refForHref("/artifacts/art_4c5d6e7f8a9b/arch.html", index)?.kind).toBe("artifact")
    expect(refForHref("/inbox", index)).toBeNull()
  })
})

describe("internal vs external", () => {
  const origin = "http://yard.test"

  it("keeps Box Yard's own pages and files in the app", () => {
    for (const href of ["/tasks/task_1", "/projects/prj_demo01?tab=captain", "/schedules#sch_0123456789ab", "/boxes#local-1", "/artifacts/art_1/a.html", "/api/uploads/u/x.png", `${origin}/tasks/task_1`, origin])
      expect(isExternal(href, origin), href).toBe(false)
  })

  it("sends every other site (GitHub, previews, protocol-relative, look-alike origins) to a new tab", () => {
    for (const href of [
      "https://github.com/acme/box-yard/pull/154",
      "https://upstash.com/docs/box",
      "https://4030-box.upstash.app/",
      "//evil.test/x",
      "http://yard.test.evil/tasks/task_1",
      "http://yard.test:4051/",
      "mailto:cody@example.com",
    ])
      expect(isExternal(href, origin), href).toBe(true)
  })
})

describe("GitHub link labels", () => {
  it("reads PR and issue URLs, with or without a trailing path, query or hash", () => {
    expect(githubRef("https://github.com/acme/box-yard/pull/154")).toEqual({ owner: "acme", repo: "box-yard", kind: "pull", number: 154 })
    expect(githubRef("https://github.com/acme/box-yard/pull/154/files#diff-1")?.number).toBe(154)
    expect(githubRef("https://www.github.com/o/r.js/issues/9?x=1")).toEqual({ owner: "o", repo: "r.js", kind: "issue", number: 9 })
  })

  it("shortens a PR to 'PR #154' and an issue to 'owner/repo#154'", () => {
    expect(shortGithubLabel("https://github.com/acme/box-yard/pull/154")).toBe("PR #154")
    expect(shortGithubLabel("https://github.com/acme/box-yard/issues/154")).toBe("acme/box-yard#154")
  })

  it("shortens a commit URL and a whole SHA in prose to git's short form, never the 40 characters", () => {
    const sha = "ff8fc2305ab9c31e61cfc78f89fadf6c2d5d42ee"
    expect(shortGithubLabel(`https://github.com/acme/box-yard/commit/${sha}`)).toBe("ff8fc23")
    expect(shortShas(`merged into main as squash commit ${sha}. Main merged cleanly`)).toBe("merged into main as squash commit ff8fc23. Main merged cleanly")
    // Not a SHA: too short, all letters or digits, or part of a longer word.
    for (const text of ["deadbeef", "a".repeat(40), "1".repeat(40), `x${sha}`]) expect(shortShas(text)).toBe(text)
  })

  it("leaves other links alone", () => {
    for (const href of ["https://github.com/acme/box-yard", "https://github.com/o/r/commit/abc", "https://github.com/o/r/pull/12abc", "https://gitlab.com/o/r/pull/1", "https://evilgithub.com/o/r/pull/1", "/tasks/task_1"])
      expect(shortGithubLabel(href), href).toBeNull()
  })
})

describe("followAppLink", () => {
  const click = (over: Partial<Parameters<typeof followAppLink>[0]> = {}) => {
    const e = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, prevented: false, preventDefault() {
      e.prevented = true
    }, ...over }
    return e
  }
  const run = (href: string, over = {}) => {
    const to: string[] = []
    const e = click(over)
    const navigated = followAppLink(e, href, (h) => to.push(h), "http://yard.test")
    return { navigated, to, prevented: e.prevented }
  }

  it("navigates in-app links through the router", () => {
    expect(run("/tasks/task_9d0e1f2a3b4c")).toEqual({ navigated: true, to: ["/tasks/task_9d0e1f2a3b4c"], prevented: true })
    expect(run("http://yard.test/schedules#sch_0123456789ab").to).toEqual(["/schedules#sch_0123456789ab"])
  })

  it("leaves modified and middle clicks to the browser (new tab)", () => {
    for (const over of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { button: 1 }])
      expect(run("/tasks/task_9d0e1f2a3b4c", over)).toEqual({ navigated: false, to: [], prevented: false })
  })

  it("leaves external links and files to the browser", () => {
    expect(run("https://github.com/acme/box-yard/pull/18")).toEqual({ navigated: false, to: [], prevented: false })
    expect(run("/artifacts/art_4c5d6e7f8a9b/arch.html").navigated).toBe(false)
  })
})

describe("toolMentions", () => {
  const texts = (ms: ReturnType<typeof toolMentions>) => ms.map((m) => [m.text, m.ref?.href ?? null])

  it("links task ids by title", () => {
    expect(texts(toolMentions("send_to_task", { task: "task_5e6f7a8b9c0d", message: "hi" }, null, index))).toEqual([
      ["Inbox: mark card as reviewed", "/tasks/task_5e6f7a8b9c0d"],
    ])
  })

  it("links every task wait_for_tasks waits on, keeping unknown ones as text", () => {
    expect(texts(toolMentions("wait_for_tasks", { tasks: ["task_5e6f7a8b9c0d", "task_ffffffffffff"] }, null, index))).toEqual([
      ["Inbox: mark card as reviewed", "/tasks/task_5e6f7a8b9c0d"],
      ["task_ffffffffffff", null],
    ])
  })

  it("links what a create tool made, from the recorded result id or a unique name", () => {
    expect(texts(toolMentions("create_task", { project: "box-yard", title: "Same title" }, "task_bbbbbbbbbbbb", index))).toEqual([["Same title", "/tasks/task_bbbbbbbbbbbb"]])
    expect(texts(toolMentions("create_task", { project: "box-yard", title: "Same title" }, null, index))).toEqual([["Same title", null]])
    expect(texts(toolMentions("create_project", { name: "box-yard" }, null, index))).toEqual([["box-yard", "/projects/prj_demo01"]])
  })

  it("links schedules and projects by id or name", () => {
    expect(texts(toolMentions("run_schedule_now", { schedule: "Morning digest" }, null, index))).toEqual([["Morning digest", "/schedules#sch_0123456789ab"]])
    expect(texts(toolMentions("save_note", { project: "prj_demo01", content: "x" }, null, index))).toEqual([["box-yard", "/projects/prj_demo01"]])
    expect(texts(toolMentions("create_task", { project: "prj_demo01", title: "New" }, null, index))).toEqual([["New", null]])
    expect(toolMentions("list_projects", {}, null, index)).toEqual([])
  })
})

describe("createdId", () => {
  it("finds the new id in a create tool result", () => {
    expect(createdId("create_task", '{"id":"task_abcdef123456","title":"x","project":"box-yard"}')).toBe("task_abcdef123456")
    expect(createdId("create_schedule", [{ type: "text", text: '{"projectId":"prj_demo01","id":"sch_abcdef123456"}' }])).toBe("sch_abcdef123456")
    expect(createdId("create_project", "Error: exists")).toBeNull()
    expect(createdId("send_to_task", "task_abcdef123456")).toBeNull()
  })
})
