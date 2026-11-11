// Items for the command palette (Cmd+K), built from data the app already has. Ranking lives in paletteRank.ts.
import type { Artifact, BoxInfo, Project, Schedule, Task, TaskStatus } from "../../../shared/types"
import { badgeStatus, prNumber, prStateOf, type BadgeStatus } from "./prState"
import type { PreviewItem } from "./filePreview"
import { projectChatHref, taskSessionHref } from "./navigation"
import { COORDINATOR_CHAT } from "./threads"
import { ALIASES as SETTINGS_ALIASES, SETTINGS_SECTIONS, settingsPath, type SettingsSection } from "./settingsNav"
import { taskTree } from "./subtaskSearch"
import type { BarPins } from "./projectBar"

export type PaletteKind = "action" | "page" | "setting" | "task" | "pr" | "project" | "schedule" | "artifact" | "box"

/** Dialogs the palette opens itself instead of navigating, and what it does in place (a project's pin in the sidebar). */
export type PaletteCommand = "settings" | "new-task" | "new-project" | "coordinator" | "shortcuts" | "pin-project" | "unpin-project"

export interface PaletteItem {
  /** Unique across kinds: `<kind>:<id>`. */
  key: string
  kind: PaletteKind
  title: string
  subtitle?: string
  /** Matched as strongly as the title (a file's name, a PR's number). */
  names?: string[]
  /** Matched like the title, ranked lower (ids, repos). */
  aliases?: string[]
  /** Matched without fuzzy hits, ranked lowest (project name, summary). */
  details?: string[]
  /** Matched from a word start only, ranked lowest, and word by word in "box-yard failed" (project name, status). */
  keywords?: string[]
  /** In-app route to open. */
  href?: string
  /** Absolute URL to open in a new tab (artifact files). */
  url?: string
  /** Another site the row links to on the side, e.g. the PR on GitHub. */
  externalUrl?: string
  /** The file behind `url`, so Enter can open it in the preview modal. */
  file?: PreviewItem
  command?: PaletteCommand
  /**
   * The chat the row opens, whose box takes the caret once it's on screen (lib/chatSwitch.ts focusComposer):
   * COORDINATOR_CHAT, a project's id (its Captain) or a task's id (its panel).
   */
  chat?: string
  /** The Settings section a "settings" command opens. */
  section?: SettingsSection
  /** The project a "pin-project" or "unpin-project" command pins or unpins. */
  project?: string
  /** The key that does the same from anywhere, shown on the row ("?" for the shortcuts sheet). */
  shortcut?: string
  /** What a "new-task" command's dialog starts with: the text typed when nothing matched. */
  prompt?: string
  /** A task's and its PR's row: the task itself, which draws its icon and state (TaskStatusIcon) or its PR's glyph. */
  task?: Task
  /** A task's state in words, for its icon's name and the PR ordering: its status, or "merged" when it is done because its PR merged. */
  status?: BadgeStatus
  /** A task's raw status, for the empty-query sections and the active boost. */
  taskStatus?: TaskStatus
  /** Last activity, for the recency boost and tie-breaks. */
  at?: number
  /** A sub-task's parent task's title, on its meta line; only a sub-task has one, so it goes in the Sub-tasks group. */
  parent?: string
  /** A sub-task's top-level task (`task:<id>`), which a search for its title lists too. */
  rootKey?: string
  /** On a top-level task the search lists only for its sub-tasks' sake: how many of their titles match. */
  subtaskHits?: number
}

const STATUS_WORDS: Record<TaskStatus, string> = {
  queued: "queued",
  starting: "starting",
  working: "working",
  needs_input: "needs you input question",
  waiting: "waiting",
  idle: "idle",
  pr_ready: "pr ready review",
  done: "done finished",
  failed: "failed error",
}

export interface PaletteData {
  tasks?: Task[]
  projects?: Project[]
  schedules?: Schedule[]
  artifacts?: Artifact[]
  boxes?: BoxInfo[]
  /** The sidebar's pins (lib/projectBar.ts), so each project has its Pin or its Unpin. */
  pins?: BarPins
  /** What "New task…" says under its title. */
  newTask?: NewTaskContext
}

/** Where "New task…" starts: the project its dialog opens on (its name: the one in view, else the first), and the text it kept from last time. */
export interface NewTaskContext {
  project?: string | null
  draft?: string
}

export const PAGES: PaletteItem[] = [
  { key: "page:coordinator", kind: "page", title: "Coordinator", subtitle: "Tasks and chat", command: "coordinator", chat: COORDINATOR_CHAT, aliases: ["home"] },
  { key: "page:settings", kind: "page", title: "Settings", subtitle: "Credentials, identities, machines, voice and limits", command: "settings", aliases: ["preferences", "open settings"] },
]

/** Every Settings section, so "voice" or "identities" opens it without going through Settings first. */
export const SETTINGS_ITEMS: PaletteItem[] = SETTINGS_SECTIONS.map((s) => ({
  key: `setting:${s.key}`,
  kind: "setting",
  title: s.label,
  subtitle: s.description,
  aliases: Object.keys(SETTINGS_ALIASES).filter((word) => SETTINGS_ALIASES[word] === s.key),
  // Where it sits ("Box providers", "GPU clouds") and what it's about.
  keywords: [...settingsPath(s.key).slice(0, -1), s.description],
  command: "settings",
  section: s.key,
}))

// The items for each task, project and file, kept while its object lives. React Query keeps an unchanged row's object
// across refetches and live updates, so reopening the palette only builds the rows that changed.
const built = new WeakMap<object, { project: string | undefined; tree: string | undefined; items: PaletteItem[] }>()

/** `row`'s items, rebuilt when the row, its project's name or (a sub-task's) its parent's title or tree changed. */
function cached(row: object, project: string | undefined, build: () => PaletteItem[], tree?: string): PaletteItem[] {
  const hit = built.get(row)
  if (hit && hit.project === project && hit.tree === tree) return hit.items
  const items = build()
  built.set(row, { project, tree, items })
  return items
}

/** A sub-task's place in its tree: its parent's title and its top-level task. */
interface Place {
  parent: string
  rootKey: string
}

/** Everything the palette can find, built from data the app already has in its query cache. */
export function buildItems(data: PaletteData): PaletteItem[] {
  const projects = data.projects ?? []
  const projectName = new Map(projects.map((p) => [p.id, p.name]))
  const items: PaletteItem[] = [...PAGES]

  const tasks = data.tasks ?? []
  const tree = taskTree(tasks)
  for (const t of tasks) {
    const project = projectName.get(t.projectId)
    const parent = tree.parent(t)
    const place = parent && { parent: parent.title, rootKey: `task:${tree.root(t).id}` }
    items.push(...cached(t, project, () => taskItems(t, project, place), place && `${place.rootKey}\n${place.parent}`))
  }
  for (const p of projects) items.push(...cached(p, undefined, () => [projectItem(p)]))
  for (const a of data.artifacts ?? []) {
    const project = a.projectId ? projectName.get(a.projectId) : undefined
    items.push(...cached(a, project, () => [artifactItem(a, project)]))
  }

  items.push(...buildActions(projects, data.pins, data.newTask), ...SETTINGS_ITEMS)
  return items
}

function taskItems(t: Task, project: string | undefined, place: Place | undefined): PaletteItem[] {
  const items: PaletteItem[] = [
    {
      ...place,
      key: `task:${t.id}`,
      kind: "task",
      title: t.title,
      subtitle: project,
      aliases: [t.id],
      details: [project ?? "", t.summary ?? ""],
      // One word each, so "done" is an exact hit on a done task.
      keywords: [project ?? "", ...STATUS_WORDS[t.status].split(" "), ...(t.prUrl ? [`pr ${t.prState ?? "open"}`] : [])],
      href: taskSessionHref(t.id),
      chat: t.id,
      task: t,
      status: badgeStatus(t),
      taskStatus: t.status,
      at: t.updatedAt,
    },
  ]
  const n = prNumber(t.prUrl)
  if (t.prUrl && n) {
    // PRs are only searched with the # prefix; a task's own row already covers it otherwise.
    items.push({
      key: `pr:${t.id}`,
      kind: "pr",
      title: t.title,
      subtitle: [`#${n}`, project, prStateOf(t)].filter(Boolean).join(" · "),
      names: [n, `#${n}`],
      aliases: [t.id],
      details: [project ?? ""],
      href: taskSessionHref(t.id),
      chat: t.id,
      externalUrl: t.prUrl,
      task: t,
      status: badgeStatus(t),
      taskStatus: t.status,
      at: t.updatedAt,
    })
  }
  return items
}

function projectItem(p: Project): PaletteItem {
  return {
    key: `project:${p.id}`,
    kind: "project",
    title: p.name,
    subtitle: p.repo ?? p.description,
    aliases: [p.id, ...(p.repo ? [p.repo, p.repo.split("/").pop()!] : [])],
    details: [p.description],
    // The row opens the project's Captain, so "captain" lists them all.
    keywords: ["Captain", p.description],
    href: projectChatHref(p.id),
    chat: p.id,
    at: p.updatedAt,
  }
}

function artifactItem(a: Artifact, project: string | undefined): PaletteItem {
  return {
    key: `artifact:${a.id}`,
    kind: "artifact",
    title: a.title,
    subtitle: [project, a.filename].filter(Boolean).join(" · "),
    names: [a.filename],
    details: [project ?? ""],
    url: a.url,
    file: { url: a.url, name: a.filename, size: a.size, mime: a.mime, title: a.title },
    at: a.createdAt,
  }
}

/** Opens the New task dialog (components/NewTask.tsx) on the project in view, with its project picker. N does the same. */
export const NEW_TASK: PaletteItem = { key: "action:new-task", kind: "action", title: "New task…", aliases: ["create task", "add task", "start task"], command: "new-task", shortcut: "N" }

/** A draft on one line, short enough to sit under a title. */
function clip(text: string, max = 60) {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

/** The kept draft as a row's subtitle, or nothing without one. */
const draftLine = (lead: string, draft?: string) => (draft && clip(draft) ? `${lead}: “${clip(draft)}”` : undefined)

/** "New task…" where the palette opened: the draft its dialog opens with, else the project it opens on. */
export const newTaskItem = ({ project, draft }: NewTaskContext = {}): PaletteItem => ({
  ...NEW_TASK,
  subtitle: draftLine("Continues your draft", draft) ?? (project ? `In ${project} · you can change it next` : undefined),
})

/** The row that starts a task from the typed text (nothing matches it, or it reads like a prompt): the dialog opens with it. */
export const newTaskFrom = (text: string, ctx: NewTaskContext = {}): PaletteItem => ({
  ...NEW_TASK,
  title: `Start a new task: “${text}”`,
  subtitle: draftLine("Adds to your draft", ctx.draft) ?? "Opens with this as the description",
  shortcut: undefined,
  prompt: text,
})

export function buildActions(projects: Project[], pins: BarPins = {}, newTask: NewTaskContext = {}): PaletteItem[] {
  return [
    newTaskItem(newTask),
    { key: "action:new-project", kind: "action", title: "New project…", command: "new-project" },
    { key: "action:shortcuts", kind: "action", title: "Keyboard shortcuts", aliases: ["hotkeys", "keybindings", "keys", "help"], command: "shortcuts", shortcut: "?" },
    ...projects.map((p) => pinAction(p, pins[p.id] === "pinned")),
  ]
}

/**
 * A project's pin, as the sidebar's row has it: Pin keeps a quiet project in the list, Unpin moves it to More projects.
 * The keyboard's way to it, since the sidebar's tree is one tab stop and the row's buttons are out of the Tab order.
 */
function pinAction(p: Project, pinned: boolean): PaletteItem {
  return {
    key: `action:pin:${p.id}`,
    kind: "action",
    title: `${pinned ? "Unpin" : "Pin"} ${p.name}`,
    subtitle: pinned ? "Move it to More projects in the sidebar" : "Keep it in the sidebar when it's quiet",
    keywords: ["sidebar"],
    command: pinned ? "unpin-project" : "pin-project",
    project: p.id,
  }
}

/** Item key for a route the user viewed, if it is one the palette remembers: the task panel (`?session=`) or Captain panel. */
export function recentKeyFor(path: string): string | null {
  const params = new URL(path, "http://boxyard.local").searchParams
  const task = params.get("session") ?? params.get("task")
  if (task) return `task:${task}`
  const project = params.get("captain") ?? params.get("project")
  if (project) return `project:${project}`
  const m = /^\/(tasks|projects)\/([^/?#]+)/.exec(path)
  if (!m) return null
  return `${m[1] === "tasks" ? "task" : "project"}:${decodeURIComponent(m[2]!)}`
}

/** Moves `key` to the front of the recent list, keeping it short. */
export function pushRecent(list: string[], key: string, max = 20): string[] {
  return [key, ...list.filter((k) => k !== key)].slice(0, max)
}
