import { describe, expect, it } from "vitest"
import { buildItems, pushRecent, recentKeyFor, type PaletteItem } from "../web/src/lib/palette.js"
import {
  FIELD_WEIGHT,
  bumpUsage,
  currentUsage,
  matchText,
  paletteRows,
  parseQuery,
  queryExtension,
  rankPalette,
  scoreItem,
  scoreText,
  targetsFile,
  type GroupKey,
  type PaletteGroup,
  type RankOptions,
} from "../web/src/lib/paletteRank.js"
import { COORDINATOR_CHAT } from "../web/src/lib/threads.js"
import type { Artifact, BoxInfo, Project, Schedule, Task, TaskStatus } from "../shared/types.js"

let n = 0
function task(title: string, status: TaskStatus = "idle", over: Partial<Task> = {}): Task {
  n += 1
  return {
    id: `tsk_${n}`,
    projectId: "prj_yard",
    title,
    prompt: "Do the thing",
    status,
    boxId: null,
    sessionId: "s",
    branch: null,
    prUrl: null,
    previews: [],
    question: null,
    summary: null,
    error: null,
    turnCount: 0,
    pendingCount: 0,
    lastArchivedAt: null,
    scheduleId: null,
    contextTokens: null,
    contextWindow: null,
    compactPending: false,
    compacting: false,
    model: null,
    effort: null,
    claudeCostUsd: 0,
    claudeTokens: 0,
    routingRule: null,
    routingReason: null,
    createdAt: n,
    updatedAt: n,
    ...over,
  }
}

function project(id: string, name: string, repo: string | null = null): Project {
  return { id, name, description: "", repo, baseBranch: "main", envKeys: [], notes: [], createdAt: 1, updatedAt: 1 }
}

const projects = [project("prj_yard", "box-yard", "acme/box-yard"), project("prj_notes", "Notes app")]
const schedules: Schedule[] = [
  {
    id: "sch_digest",
    target: "orchestrator",
    projectId: null,
    name: "Morning digest",
    cron: "0 9 * * *",
    timezone: "UTC",
    prompt: "summarize",
    enabled: true,
    catchUp: "once",
    allowOverlap: false,
    nextRunAt: null,
    lastRunAt: null,
    lastTaskId: null,
    lastSkipReason: null,
    runCount: 0,
    qstashId: null,
    createdAt: 1,
    updatedAt: 1,
  },
]
const artifact = (id: string, title: string, filename: string, createdAt = 1): Artifact => ({
  id,
  projectId: "prj_yard",
  taskId: null,
  title,
  filename,
  mime: "application/octet-stream",
  size: 1,
  url: `/artifacts/${id}/${filename}`,
  createdAt,
})
const artifacts: Artifact[] = [artifact("art_1", "Architecture diagram", "arch.html")]
const boxes: BoxInfo[] = [
  { id: "box_abc123", provider: "mock", status: "ready", slots: 2, runningTurns: 1, residentTasks: [], projects: ["box-yard"], createdAt: 1, lastUsedAt: 1 },
]

const NOW = 10 * 86_400_000
const titles = (g: PaletteGroup | undefined) => g?.items.map((i) => i.title) ?? []
const group = (groups: PaletteGroup[], key: GroupKey) => groups.find((g) => g.key === key)
const search = (items: PaletteItem[], raw: string, opts: RankOptions = {}) => rankPalette(items, parseQuery(raw), { now: NOW, ...opts })

describe("match tiers", () => {
  it("ranks exact over prefix over word start over substring over fuzzy", () => {
    expect(matchText("Inbox", "inbox")!.tier).toBe("exact")
    expect(matchText("Inbox zero", "inbox")!.tier).toBe("prefix")
    expect(matchText("Clean the inbox", "inbox")!.tier).toBe("word")
    expect(matchText("Sandboxing", "box")!.tier).toBe("substring")
    expect(matchText("command palette", "cmdpal")!.tier).toBe("fuzzy")
    const scores = [scoreText("Inbox", "inbox")!, scoreText("Inbox zero", "inbox")!, scoreText("Clean the inbox", "inbox")!, scoreText("Sandboxing", "box")!, scoreText("command palette", "cmdpal")!]
    expect([...scores].sort((a, b) => b - a)).toEqual(scores)
    expect(scores.at(-1)).toBeGreaterThan(0)
  })

  it("never lets a penalty drop a match into the tier below", () => {
    const longPrefix = scoreText(`inbox ${"x".repeat(200)}`, "inbox")!
    const earlyWord = scoreText("the inbox", "inbox")!
    const lateWord = scoreText(`${"x ".repeat(100)}inbox`, "inbox")!
    const earlySub = scoreText("sandbox", "box")!
    const bestFuzzy = scoreText("c-m-d", "cmd")!
    expect(longPrefix).toBeGreaterThan(earlyWord)
    expect(lateWord).toBeGreaterThan(earlySub)
    expect(scoreText(`x${"y".repeat(200)}box`, "box")!).toBeGreaterThan(bestFuzzy)
  })

  it("is case-insensitive and rejects scattered or missing letters", () => {
    expect(scoreText("Command Palette", "command")).not.toBeNull()
    expect(scoreText("abcdefghijklmnopqrstuvwxyz", "az")).toBeNull()
    expect(scoreText("Inbox", "outbox")).toBeNull()
    // Fuzzy hits have to start at a word.
    expect(scoreText("Deploy nebula", "dpl")).not.toBeNull()
    expect(scoreText("Command palette", "dpl")).toBeNull()
    expect(scoreText("Deploy nebula", "dpl", false)).toBeNull()
  })

  it("prefers a later word-start hit over an earlier mid-word one", () => {
    expect(matchText("sandbox box", "box")!.tier).toBe("word")
  })
})

describe("fields", () => {
  const item = (over: Partial<PaletteItem>): PaletteItem => ({ key: `task:${over.title}`, kind: "task", title: "Something else", ...over })
  const ctx = { now: NOW }

  it("weighs a title match over the same match in an id, project or summary", () => {
    const title = scoreItem(item({ title: "deploy" }), "deploy", ctx)!
    const id = scoreItem(item({ aliases: ["deploy"] }), "deploy", ctx)!
    const detail = scoreItem(item({ details: ["deploy"] }), "deploy", ctx)!
    expect(title).toBeGreaterThan(id)
    expect(id).toBeGreaterThan(detail)
    expect(FIELD_WEIGHT.title).toBeGreaterThan(FIELD_WEIGHT.alias)
    // A title prefix still beats an exact id.
    expect(scoreItem(item({ title: "deploy nebula" }), "deploy", ctx)!).toBeGreaterThan(id)
  })

  it("matches summaries by words, never by scattered letters", () => {
    expect(scoreItem(item({ details: ["Moved the palette scoring into a pure module"] }), "scoring", ctx)).not.toBeNull()
    expect(scoreItem(item({ details: ["Moved the palette scoring into a pure module"] }), "mtps", ctx)).toBeNull()
  })

  it("finds a task by its summary", () => {
    const items = buildItems({ tasks: [task("Palette work", "done", { summary: "Ranked tasks above files" })], projects })
    expect(titles(group(search(items, "above files"), "task"))).toEqual(["Palette work"])
  })
})

describe("files", () => {
  it("detects a file extension in the query", () => {
    expect(queryExtension(".png")).toBe("png")
    expect(queryExtension("logo.PNG")).toBe("png")
    expect(queryExtension("report.md")).toBe("md")
    for (const ext of ["jpg", "gif", "svg", "html", "csv", "json", "webm", "mp4", "txt", "pdf"]) expect(queryExtension(`x.${ext}`)).toBe(ext)
    expect(queryExtension("v1.2")).toBeNull()
    expect(queryExtension("box.yard")).toBeNull()
    expect(queryExtension("png")).toBeNull()
    expect(queryExtension(".png later")).toBeNull()
  })

  const files = [artifact("art_a", "Empty query desktop", "palette-empty.png", 5), artifact("art_b", "Palette notes", "notes.md", 4), artifact("art_c", "Old shot", "old.jpeg", 3)]
  const tasks = [task("Palette screenshots .png", "working", { updatedAt: NOW }), task("Palette ranking", "working", { updatedAt: NOW })]
  const items = buildItems({ tasks, projects, artifacts: files })

  it("targets files on an extension or a near-exact file name, not on a loose word", () => {
    expect(targetsFile(".png", items)).toBe(true)
    expect(targetsFile("notes", items)).toBe(true)
    expect(targetsFile("palette-empty", items)).toBe(true)
    expect(targetsFile("palette", items)).toBe(false)
    expect(targetsFile("no", items)).toBe(false)
  })

  it("puts files first for a .png query and lists every PNG", () => {
    const groups = search(items, ".png")
    expect(groups[0]!.key).toBe("artifact")
    expect(titles(groups[0])).toEqual(["Empty query desktop"])
    expect(titles(group(groups, "task"))).toEqual(["Palette screenshots .png"])
    expect(titles(search(items, ".jpg")[0])).toEqual(["Old shot"])
  })

  it("keeps tasks first when the query only shares a word with a file", () => {
    const groups = search(items, "palette")
    expect(groups[0]!.key).toBe("task")
    expect(group(groups, "artifact")).toBeDefined()
  })
})

describe("task boost", () => {
  it("lets a task win a tie against a file, a project and a command", () => {
    const items = buildItems({
      tasks: [task("Deploy", "done", { updatedAt: 0 })],
      projects: [project("prj_d", "Deploy")],
      artifacts: [artifact("art_d", "Deploy", "deploy-log.bin")],
    })
    const groups = search(items, "deploy")
    expect(groups.map((g) => g.key).slice(0, 2)).toEqual(["task", "project"])
    expect(groups.findIndex((g) => g.key === "artifact")).toBeGreaterThan(0)
  })

  it("adds small boosts for recent and active tasks that don't jump a match tier", () => {
    const ctx = { now: NOW }
    const [old, fresh, waiting] = buildItems({
      tasks: [task("Deploy staging", "done", { updatedAt: 0 }), task("Deploy staging", "done", { updatedAt: NOW }), task("Deploy staging", "needs_input", { updatedAt: 0 })],
    }).filter((i) => i.kind === "task")
    expect(scoreItem(fresh!, "deploy", ctx)!).toBeGreaterThan(scoreItem(old!, "deploy", ctx)!)
    expect(scoreItem(waiting!, "deploy", ctx)!).toBeGreaterThan(scoreItem(old!, "deploy", ctx)!)
    const [exactOld] = buildItems({ tasks: [task("deploy", "done", { updatedAt: 0 })] }).filter((i) => i.kind === "task")
    expect(scoreItem(exactOld!, "deploy", ctx)!).toBeGreaterThan(scoreItem(waiting!, "deploy", ctx)!)
  })
})

describe("stable order", () => {
  it("breaks equal scores the same way every time, newest then by key", () => {
    const tied = buildItems({
      tasks: [task("Bug b", "done", { id: "tsk_b", updatedAt: 1 }), task("Bug a", "done", { id: "tsk_a", updatedAt: 1 }), task("Bug c", "done", { id: "tsk_c", updatedAt: 1 })],
    })
    const order = titles(group(search(tied, "bug"), "task"))
    expect(order).toEqual(["Bug a", "Bug b", "Bug c"])
    expect(titles(group(search([...tied].reverse(), "bug"), "task"))).toEqual(order)
  })

  it("keeps the relative order of rows as the query grows", () => {
    const many = buildItems({ tasks: Array.from({ length: 8 }, (_, i) => task(`Deploy box ${i}`, "done", { id: `tsk_${i}`, updatedAt: 1 })) })
    const keys = (raw: string) => group(search(many, raw, { expanded: new Set(["task"]) }), "task")!.items.map((i) => i.key)
    expect(keys("dep")).toEqual(keys("deploy"))
    expect(keys("deploy")).toEqual(keys("deploy b"))
  })

  it("breaks score ties by recency", () => {
    const tied = buildItems({ tasks: [task("Deploy staging", "idle", { updatedAt: 1 }), task("Deploy prod", "idle", { updatedAt: 99 })] })
    expect(titles(group(search(tied, "deploy"), "task"))).toEqual(["Deploy prod", "Deploy staging"])
  })
})

describe("prefixes", () => {
  it("parses each prefix and leaves other text alone", () => {
    expect(parseQuery("  > New ")).toMatchObject({ scope: "command", query: "new" })
    expect(parseQuery("#78")).toMatchObject({ scope: "pr", query: "78" })
    expect(parseQuery("f:logo.png")).toMatchObject({ scope: "file", query: "logo.png" })
    expect(parseQuery("F: Logo")).toMatchObject({ scope: "file", query: "logo", rest: "Logo" })
    expect(parseQuery("p:yard")).toMatchObject({ scope: "project", query: "yard" })
    expect(parseQuery("@box")).toMatchObject({ scope: null, query: "@box" })
    expect(parseQuery(" Dark   Mode ")).toEqual({ scope: null, query: "dark mode", rest: " Dark   Mode " })
    expect(parseQuery("fix: p:")).toMatchObject({ scope: null })
  })

  const tasks = [
    task("Smarter palette", "pr_ready", { prUrl: "https://github.com/acme/box-yard/pull/79", updatedAt: 3 }),
    task("Voice providers", "done", { prUrl: "https://github.com/acme/box-yard/pull/78", prState: "merged", updatedAt: 2 }),
    task("No PR here", "working"),
  ]
  const items = buildItems({ tasks, projects, schedules, artifacts, boxes })

  it("> shows only commands and pages", () => {
    const groups = search(items, ">new project")
    expect(groups.map((g) => g.key)).toEqual(["command"])
    expect(titles(groups[0])).toEqual(["New project…"])
    expect(search(items, ">settings")[0]!.items[0]!.command).toBe("settings")
    expect(search(items, ">")[0]!.total).toBe(5)
    expect(titles(search(items, ">hotkeys")[0])).toEqual(["Keyboard shortcuts"])
    expect(search(items, ">new task")).toEqual([])
  })

  it("# finds PRs by number or title, open ones first", () => {
    expect(titles(search(items, "#79")[0])).toEqual(["Smarter palette"])
    expect(titles(search(items, "##78")[0])).toEqual(["Voice providers"])
    expect(titles(search(items, "#voice")[0])).toEqual(["Voice providers"])
    expect(titles(search(items, "#")[0])).toEqual(["Smarter palette", "Voice providers"])
    expect(search(items, "#")[0]!.items[0]!.externalUrl).toBe("https://github.com/acme/box-yard/pull/79")
    // PR rows only show up behind the prefix; the task row covers them otherwise.
    expect(group(search(items, "smarter"), "pr")).toBeUndefined()
  })

  it("f: and p: narrow to files and projects", () => {
    expect(search(items, "f:arch").map((g) => g.key)).toEqual(["artifact"])
    expect(search(items, "f:").map((g) => g.key)).toEqual(["artifact"])
    // Projects in the owner's saved order (the list's order), not by age or name.
    expect(titles(search(items, "p:")[0])).toEqual(["box-yard", "Notes app"])
    const reordered = buildItems({ tasks: [], projects: [projects[1]!, projects[0]!] })
    expect(titles(search(reordered, "p:")[0])).toEqual(["Notes app", "box-yard"])
    expect(search(items, "p:box").map((g) => g.key)).toEqual(["project"])
    expect(search(items, "@abc")).toEqual([])
  })
})

describe("chats", () => {
  it("names the chat whose box a pick focuses: the Coordinator, a Captain, a task or sub-task, a PR's task; nothing else", () => {
    const t = task("Add a rail", "working", { prUrl: "https://github.com/o/r/pull/7" })
    const kid = task("Rail icons", "idle", { parentTaskId: t.id, rootTaskId: t.id })
    const items = buildItems({ tasks: [t, kid], projects, schedules, artifacts, boxes })
    const chats = Object.fromEntries(items.flatMap((i) => (i.chat ? [[i.key, i.chat]] : [])))
    expect(chats).toEqual({
      "page:coordinator": COORDINATOR_CHAT,
      [`task:${t.id}`]: t.id,
      [`pr:${t.id}`]: t.id,
      [`task:${kid.id}`]: kid.id,
      "project:prj_yard": "prj_yard",
      "project:prj_notes": "prj_notes",
    })
    // Settings, the other commands and files open no chat.
    expect(items.filter((i) => !i.chat).map((i) => i.kind)).toEqual(expect.arrayContaining(["page", "setting", "action", "artifact"]))
  })
})

describe("rankPalette", () => {
  const tasks = [
    task("Fix login redirect", "failed", { updatedAt: 50 }),
    task("Add dark mode", "working", { updatedAt: 90 }),
    task("Dark mode for the Inbox", "done", { updatedAt: 10 }),
    task("Write docs", "done", { projectId: "prj_notes", updatedAt: 5 }),
  ]
  const items = buildItems({ tasks, projects, schedules, artifacts, boxes })

  it("finds every kind of thing", () => {
    // A title prefix beats a later word start, even on a working task.
    expect(titles(group(search(items, "dark"), "task"))).toEqual(["Dark mode for the Inbox", "Add dark mode"])
    expect(titles(group(search(items, "notes"), "project"))).toEqual(["Notes app"])
    expect(titles(group(search(items, "acme"), "project"))).toEqual(["box-yard"])
    expect(titles(group(search(items, "digest"), "schedule"))).toEqual([])
    expect(titles(group(search(items, "architecture"), "artifact"))).toEqual(["Architecture diagram"])
    expect(titles(group(search(items, "abc123"), "box"))).toEqual([])
    expect(titles(group(search(items, "sched"), "command"))).toEqual([])
  })

  it("finds done tasks in every project", () => {
    expect(titles(group(search(items, "docs"), "task"))).toEqual(["Write docs"])
  })

  it("orders groups by their best match so exact hits come first", () => {
    const groups = search(items, "inbox")
    expect(groups[0]!.key).toBe("task")
    expect(titles(group(groups, "task"))).toEqual(["Dark mode for the Inbox"])
  })

  it("matches multi-word queries against project and status", () => {
    expect(titles(group(search(items, "box-yard failed"), "task"))).toEqual(["Fix login redirect"])
    expect(titles(group(search(items, "notes done"), "task"))).toEqual(["Write docs"])
  })

  it("lists the tasks in a state for its word, newest first, under title hits", () => {
    const states = buildItems({
      tasks: [
        task("Fix login redirect", "failed", { updatedAt: 50 }),
        task("Ship it", "done", { updatedAt: 20 }),
        task("Land the PR", "done", { updatedAt: 30, prUrl: "https://github.com/a/b/pull/7", prState: "merged" }),
        task("Mark done button", "working", { updatedAt: 40 }),
        task("Abandoned idea", "idle", { updatedAt: 60 }),
      ],
      projects,
    })
    // A title word first, then every done task (merged ones too), then a title that only has "done" mid-word.
    expect(titles(group(search(states, "done"), "task"))).toEqual(["Mark done button", "Land the PR", "Ship it", "Abandoned idea"])
    expect(titles(group(search(states, "finished"), "task"))).toEqual(["Land the PR", "Ship it"])
    expect(titles(group(search(states, "merged"), "task"))).toEqual(["Land the PR"])
    expect(titles(group(search(states, "idle"), "task"))).toEqual(["Abandoned idea"])
    expect(titles(group(search(states, "failed"), "task"))).toEqual(["Fix login redirect"])
    // Only from a word start, and not for two letters.
    expect(titles(group(search(states, "on"), "task"))).not.toContain("Ship it")
    expect(titles(group(search(states, "id"), "task"))).toEqual(["Abandoned idea"])
  })

  it("opens a Settings section by its name, another word for it, or what it's about", () => {
    const voice = search(items, "voice")
    expect(voice[0]!.key).toBe("setting")
    expect(voice[0]!.items[0]).toMatchObject({ title: "Voice", command: "settings", section: "voice" })
    expect(group(search(items, "credentials"), "setting")!.items[0]!.section).toBe("credentials")
    expect(group(search(items, "budget"), "setting")!.items[0]!.section).toBe("costs")
    // "gpu" opens Box providers, where the Default GPU cloud is picked.
    expect(group(search(items, "gpu"), "setting")!.items[0]!.section).toBe("runners")
    // Its place in Settings counts as a word too.
    expect(group(search(items, "gpu clouds"), "setting")!.items.map((i) => i.section)).toEqual(expect.arrayContaining(["runpod", "vast"]))
    // A task named the same still comes first, and > stays about commands.
    expect(search(buildItems({ tasks: [task("Voice")] }), "voice").map((g) => g.key)).toEqual(["task", "setting"])
    expect(search(items, ">voice")).toEqual([])
    expect(search(items, "")).not.toContainEqual(expect.objectContaining({ key: "setting" }))
  })

  it("lists every project's Captain for \"captain\"", () => {
    expect(titles(group(search(items, "captain"), "project")).sort()).toEqual(["Notes app", "box-yard"])
    expect(search(items, "captain")[0]!.key).toBe("project")
    expect(titles(group(search(items, "notes captain"), "project"))).toEqual(["Notes app"])
  })

  it("never offers retired pages, schedules, or boxes", () => {
    expect(items.some((i) => i.kind === "schedule" || i.kind === "box")).toBe(false)
    expect(items.filter((i) => i.href).every((i) => i.href!.startsWith("/"))).toBe(true)
  })

  it("returns nothing when nothing matches", () => {
    expect(search(items, "zzzzqqq")).toEqual([])
  })
})

describe("group caps", () => {
  const many = buildItems({
    tasks: Array.from({ length: 12 }, (_, i) => task(`Bug ${i}`, "done", { updatedAt: i })),
    projects: Array.from({ length: 6 }, (_, i) => project(`prj_bug${i}`, `Bug tracker ${i}`)),
    artifacts: Array.from({ length: 7 }, (_, i) => artifact(`art_bug${i}`, `Bug report ${i}`, `bug-${i}.txt`)),
  })

  it("caps tasks at 5, files and projects at 3, and counts the rest", () => {
    const groups = search(many, "bug")
    expect(group(groups, "task")).toMatchObject({ total: 12 })
    expect(group(groups, "task")!.items).toHaveLength(5)
    expect(group(groups, "project")!.items).toHaveLength(3)
    expect(group(groups, "artifact")!.items).toHaveLength(3)
    expect(group(groups, "artifact")!.total).toBe(7)
  })

  it("expands a group in place and ends each capped group with a Show N more row", () => {
    const rows = paletteRows(search(many, "bug"))
    expect(rows.filter((r) => r.type === "more" && r.group !== "command").map((r) => r.type === "more" && [r.group, r.total])).toEqual([
      ["task", 12],
      ["project", 6],
      ["artifact", 7],
    ])
    expect(rows[5]).toEqual({ type: "more", group: "task", total: 12 })
    const open = paletteRows(search(many, "bug", { expanded: new Set(["task"]) }))
    expect(open.filter((r) => r.group === "task")).toHaveLength(12)
    // The first row that was hidden takes the Show N more row's place.
    expect(open[5]).toMatchObject({ type: "item", group: "task" })
    // Newest first: Bug 9 … Bug 5 were shown, Bug 4 is next.
    expect(open[5]!.type === "item" && open[5]!.item.title).toBe("Bug 4")
  })
})

describe("sub-tasks", () => {
  // Cody's case: a parent with 14 sub-tasks that all say "logo", each newer than it.
  const parent = task("Box Yard logo exploration: 10 designer sub-tasks, 4 rater sub-tasks, top 5 SVGs", "waiting", { updatedAt: 100 })
  const kids = Array.from({ length: 14 }, (_, i) =>
    task(i < 10 ? `Logo designer ${i + 1}` : `Logo rater ${i - 9}`, "done", { parentTaskId: parent.id, rootTaskId: parent.id, subtaskDepth: 1, updatedAt: 200 + i }),
  )
  const grandkid = task("Logo designer 3 retry", "idle", { parentTaskId: kids[2]!.id, rootTaskId: parent.id, subtaskDepth: 2, updatedAt: 300 })
  const upload = task("Custom logo upload in Project settings", "idle", { updatedAt: 50 })
  const brand = task("Brand refresh", "idle", { updatedAt: 60 })
  const sketches = task("Wordmark sketches", "done", { parentTaskId: brand.id, rootTaskId: brand.id, updatedAt: 70 })
  const colours = task("Wordmark colours", "done", { parentTaskId: brand.id, rootTaskId: brand.id, updatedAt: 80 })
  const licence = task("Wordmark font licence", "idle", { updatedAt: 20 })
  const items = buildItems({ tasks: [parent, ...kids, grandkid, upload, brand, sketches, colours, licence], projects })
  const item = (t: Task) => items.find((i) => i.key === `task:${t.id}`)!

  it("lists the top-level tasks first and the sub-tasks in their own group right below, a few of them", () => {
    const groups = search(items, "logo")
    expect(groups.map((g) => g.key).slice(0, 2)).toEqual(["task", "subtask"])
    expect(group(groups, "task")!.label).toBe("Tasks")
    expect(group(groups, "subtask")!.label).toBe("Sub-tasks")
    // Before, the sub-tasks' "Logo …" prefix hits filled the one Tasks group and pushed the parent behind Show all.
    expect(titles(group(groups, "task"))).toEqual([parent.title, upload.title])
    expect(group(groups, "subtask")).toMatchObject({ total: 15 })
    expect(group(groups, "subtask")!.items).toHaveLength(3)
    const rows = paletteRows(groups)
    expect(rows.findIndex((r) => r.type === "item" && r.item.key === `task:${parent.id}`)).toBe(0)
    expect(rows.find((r) => r.type === "more" && r.group === "subtask")).toEqual({ type: "more", group: "subtask", total: 15 })
    expect(group(search(items, "logo", { expanded: new Set(["subtask"]) }), "subtask")!.items).toHaveLength(15)
  })

  it("keeps Sub-tasks under Tasks even when a sub-task matches far better", () => {
    // "Logo designer 1" is a prefix hit on a sub-task; the parent only matches word by word.
    const groups = search(items, "logo designer 1")
    expect(titles(group(groups, "subtask"))[0]).toBe("Logo designer 1")
    expect(groups.map((g) => g.key).slice(0, 2)).toEqual(["task", "subtask"])
    expect(titles(group(groups, "task"))).toEqual([parent.title])
  })

  it("names each sub-task's parent and the top of its tree", () => {
    expect(item(kids[0]!)).toMatchObject({ parent: parent.title, rootKey: `task:${parent.id}`, subtitle: "box-yard" })
    expect(item(grandkid)).toMatchObject({ parent: "Logo designer 3", rootKey: `task:${parent.id}` })
    expect(item(parent).parent).toBeUndefined()
    expect(item(parent).rootKey).toBeUndefined()
  })

  it("lists a parent whose sub-tasks' titles match under the direct matches, with how many", () => {
    const groups = search(items, "wordmark")
    expect(titles(group(groups, "task"))).toEqual(["Wordmark font licence", "Brand refresh"])
    expect(group(groups, "task")!.items.map((i) => i.subtaskHits)).toEqual([undefined, 2])
    expect(titles(group(groups, "subtask"))).toEqual(["Wordmark colours", "Wordmark sketches"])
    // Only a sub-task matches: its parent still comes first, in Tasks.
    const only = search(items, "sketches")
    expect(only.map((g) => g.key).slice(0, 2)).toEqual(["task", "subtask"])
    expect(group(only, "task")!.items).toMatchObject([{ title: "Brand refresh", subtaskHits: 1 }])
    // A sub-task found by its status or project, not its title, doesn't list its parent.
    expect(titles(group(search(items, "done"), "task"))).not.toContain("Brand refresh")
    // Nor do sub-tasks under a prefix, which has no Tasks group.
    expect(search(items, "p:wordmark")).toEqual([])
  })

  it("takes a parent whose title matches as itself, not again for its sub-tasks", () => {
    const groups = search(items, "logo")
    expect(group(groups, "task")!.items.filter((i) => i.key === `task:${parent.id}`)).toEqual([expect.not.objectContaining({ subtaskHits: expect.anything() })])
  })

  it("treats a sub-task whose parent is gone as top-level", () => {
    const orphan = task("Logo orphan", "idle", { parentTaskId: "tsk_gone", rootTaskId: "tsk_gone" })
    const list = buildItems({ tasks: [orphan], projects })
    expect(titles(group(search(list, "logo"), "task"))).toEqual(["Logo orphan"])
    expect(group(search(list, "logo"), "subtask")).toBeUndefined()
  })

  it("rebuilds a sub-task's item when its parent is renamed, and keeps it otherwise", () => {
    const tasks = [parent, ...kids, grandkid, upload, brand, sketches, colours, licence]
    expect(buildItems({ tasks: [...tasks], projects }).find((i) => i.key === `task:${kids[0]!.id}`)).toBe(item(kids[0]!))
    const renamed = buildItems({ tasks: [{ ...parent, title: "Logo pick" }, ...tasks.slice(1)], projects })
    expect(renamed.find((i) => i.key === `task:${kids[0]!.id}`)!.parent).toBe("Logo pick")
  })

  it("shows sub-tasks with their parent in the empty-query sections too", () => {
    const working = task("Logo designer 11", "working", { parentTaskId: parent.id, rootTaskId: parent.id, updatedAt: 400 })
    const groups = search(buildItems({ tasks: [parent, working], projects }), "")
    expect(group(groups, "working")!.items).toMatchObject([{ title: "Logo designer 11", parent: parent.title }])
  })
})

describe("empty query", () => {
  const tasks = [
    task("Answer me", "needs_input", { updatedAt: 40 }),
    task("Review me", "pr_ready", { updatedAt: 50 }),
    task("Busy", "working", { updatedAt: 30 }),
    task("Booting", "starting", { updatedAt: 35 }),
    task("Finished", "done", { updatedAt: 60 }),
    task("Resting", "idle", { updatedAt: 70 }),
  ]
  const items = buildItems({ tasks, projects, schedules, artifacts, boxes })

  it("shows waiting tasks, working tasks, recently viewed and the most-used commands; no files", () => {
    const groups = search(items, "  ", {
      recent: [`task:${tasks[1]!.id}`, "project:prj_notes", "task:tsk_gone", `task:${tasks[5]!.id}`, "artifact:art_1"],
      usage: { "action:new-project": 4, "page:boxes": 2 },
    })
    expect(groups.map((g) => g.key)).toEqual(["waiting", "working", "recent", "command"])
    expect(groups[0]!.label).toBe("Waiting on Cody")
    expect(titles(groups[0])).toEqual(["Review me", "Answer me"])
    expect(titles(groups[1])).toEqual(["Booting", "Busy"])
    // Tasks already shown above, missing ones and files are left out.
    expect(titles(groups[2])).toEqual(["Notes app", "Resting"])
    expect(titles(groups[3]).slice(0, 3)).toEqual(["New project…", "Coordinator", "Settings"])
    expect(groups.some((g) => g.items.some((i) => i.kind === "artifact"))).toBe(false)
  })

  it("leaves out empty sections but always offers commands", () => {
    const groups = search(buildItems({ tasks: [task("Finished", "done")] }), "")
    expect(groups.map((g) => g.key)).toEqual(["command"])
    expect(groups[0]!.items).toHaveLength(5)
  })
})

describe("search index", () => {
  const yard = [
    task("Fix the command palette", "failed", { summary: "Moved the palette scoring into a pure module" }),
    task("Command palette speed", "working", { prUrl: "https://github.com/acme/box-yard/pull/1234", prState: "open" }),
    // "ab" is too spread out to be a fuzzy hit, but "abc" is one.
    task("a xxxxxxxxbc"),
    task("Ünïcode TITLE with CAPS", "pr_ready"),
    task("Deploy nebula", "done", { projectId: "prj_notes" }),
  ]
  const items = buildItems({
    tasks: yard,
    projects,
    artifacts: [artifact("art_1", "Logo", "logo.jpg"), artifact("art_2", "Notes", "notes.md"), artifact("art_3", "Palette empty", "palette-empty.png")],
  })
  const QUERIES = ["command palette", "abc", "done", "captain", "voice", "box-yard failed", "notes app deploy", "ünïcode caps", ".jpeg", "logo.jpg", "#1234", "f:palette-empty.png", "tsk_", "p:box"]
  const KINDS: Record<string, string[]> = { pr: ["pr"], file: ["artifact"], project: ["project"] }
  const ALL = new Set<GroupKey>(["task", "pr", "project", "command", "setting", "artifact"])
  const found = (groups: PaletteGroup[]) => groups.flatMap((g) => g.items.map((i) => i.key)).sort()
  /** Every item that scores, checked one by one: no index, nothing carried over from the last keystroke. */
  const scoring = (raw: string) => {
    const { scope, query } = parseQuery(raw)
    const q = scope === "pr" ? query.replace(/^#/, "") : query
    return items
      .filter((i) => (scope ? KINDS[scope]!.includes(i.kind) : i.kind !== "pr") && scoreItem(i, q, { now: NOW }) !== null)
      .map((i) => i.key)
      .sort()
  }

  it("narrows as you type to exactly the items that score", () => {
    for (const q of QUERIES) {
      for (let i = 1; i <= q.length; i++) {
        // "#" or "f:" alone browses instead of ranking.
        if (!parseQuery(q.slice(0, i)).query.replace(/^#/, "")) continue
        expect(found(search(items, q.slice(0, i), { expanded: ALL })), q.slice(0, i)).toEqual(scoring(q.slice(0, i)))
      }
    }
    expect(titles(group(search(items, "abc"), "task"))).toEqual(["a xxxxxxxxbc"])
    expect(found(search(items, ".jpeg"))).toEqual(["artifact:art_1"])
  })

  it("starts over when the query is edited or the prefix changes", () => {
    for (const [a, b] of [["palette", "pal"], ["command", "speed"], ["#12", "12"], ["p:box", "box"], ["notes", "f:notes"]] as const) {
      search(items, a)
      expect(found(search(items, b, { expanded: ALL })), `${a} → ${b}`).toEqual(scoring(b))
    }
  })

  it("keeps an unchanged row's items and rebuilds a changed row or a renamed project's rows", () => {
    const item = (list: PaletteItem[], key: string) => list.find((i) => i.key === key)!
    const fix = `task:${yard[0]!.id}`
    // A refetch keeps unchanged rows' objects in a new list.
    expect(item(buildItems({ tasks: [...yard], projects }), fix)).toBe(item(items, fix))
    // A live update replaces the task's object, a rename the project's.
    const renamed = buildItems({ tasks: [{ ...yard[0]!, title: "Fixed the command palette" }, ...yard.slice(1)], projects: [project("prj_yard", "yard"), projects[1]!] })
    expect(item(renamed, fix).title).toBe("Fixed the command palette")
    expect(item(renamed, `task:${yard[1]!.id}`).subtitle).toBe("yard")
    expect(titles(group(search(renamed, "yard failed"), "task"))).toEqual(["Fixed the command palette"])
    expect(item(renamed, `task:${yard[4]!.id}`)).toBe(item(items, `task:${yard[4]!.id}`))
  })
})

describe("helpers", () => {
  it("remembers task and project routes", () => {
    expect(recentKeyFor("/tasks/tsk_1")).toBe("task:tsk_1")
    expect(recentKeyFor("/projects/prj_a?tab=notes")).toBe("project:prj_a")
    expect(recentKeyFor("/?session=tsk_2")).toBe("task:tsk_2")
    expect(recentKeyFor("/?captain=prj_b&settings=voice")).toBe("project:prj_b")
    expect(recentKeyFor("/?settings=voice")).toBeNull()
    expect(recentKeyFor("/inbox")).toBeNull()
    expect(pushRecent(["a", "b", "c"], "b")).toEqual(["b", "a", "c"])
    expect(pushRecent(["a", "b"], "c", 2)).toEqual(["c", "a"])
    expect(pushRecent(Array.from({ length: 30 }, (_, i) => `k${i}`), "new")).toHaveLength(20)
  })

  it("counts command use", () => {
    expect(bumpUsage(bumpUsage({}, "page:inbox"), "page:inbox")).toEqual({ "page:inbox": 2 })
  })

  it("keeps a count saved under the Coordinator page's former key", () => {
    expect(currentUsage({ "page:zen": 3, "page:settings": 1 })).toEqual({ "page:coordinator": 3, "page:settings": 1 })
    expect(currentUsage({ "page:zen": 2, "page:coordinator": 1 })).toEqual({ "page:coordinator": 3 })
    const saved = { "page:settings": 1 }
    expect(currentUsage(saved)).toBe(saved)
  })
})
