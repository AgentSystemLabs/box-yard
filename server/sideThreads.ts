// Side threads: Cody highlights a passage in the Coordinator chat (or a project Captain's chat) and asks about it.
// The question runs in its own Claude session, forked from the chat's session at the highlighted message
// (`--resume <chat> --resume-session-at <uuid> --fork-session`), so the thread knows everything up to and including
// that message and nothing after it. The chat's own session and transcript are never touched: a fork writes a new
// session file, and the thread's messages live in their own table.
//
// When the fork point is older than the chat's last compaction (or the chat's session was reset), the thread starts
// a fresh session instead, with the summary of the compaction before the highlighted message plus the messages from
// there up to it (context "summary").
//
// A task's card in the Coordinator chat has a thread too (kind "task", one per card, anchored on the task's id): Cody's
// questions to the Coordinator about that task, answered in the card. It forks the Coordinator's session at its newest
// answer and starts from the task as it stands now (ThreadHost.taskState) and its updates in the chat. Like every
// thread, the main chat and its session never see it. Old ones on a batch card (`batch:<id>`, before every task had its
// own card) stay listed and readable, but have no task to go on with.
//
// Threads are for questions: they see the chat's tools (so the fork keeps the chat's prompt cache) but may only use
// the read-only ones in THREAD_TOOLS. The CLI refuses the rest (dontAsk with an allowlist), and so does the MCP
// server, for the thread's own read-only token.
//
// A chat on Codex (docs/codex.md) can't be forked at a message, so its threads always start the "summary" way, on
// Codex, and only the MCP server's read-only token keeps them to the lookups.
//
// A thread runs on its chat's model and effort, unless Settings › Coordinator › Quick questions picks others for
// threads on Claude chats (quickQuestionHost), e.g. Haiku.
//
// An ask in a Captain's chat can be about a passage of one of its project's task transcripts instead of a chat
// message (the selection's Ask in a task's panel): it's anchored on the task's id, starts from the Captain's newest
// message and names the task, which the Captain can read with get_task.
//
// A thread can be asked from inside another one (a passage highlighted in the parent's panel, parent_id), to any
// depth. It forks the parent's own session where it stands, so it knows the chat and everything said in the parent;
// when that can't be forked it starts fresh from the parent's messages. Deleting a thread deletes the ones under it.
//
// A reply thread (the one Reply on every message) routes each of Cody's messages in its own turn, with no extra model
// call: the chat's agent answers a question there, or answers with a directive (shared/threadRoutes.ts) and Box Yard
// sends Cody's words on unchanged, to the task's agent (`[[route:agent]]`, when the message is about a task) or into
// the main chat (`[[route:chat]]`), where the Coordinator or Captain acts on it. The route is kept on the message, so
// the thread shows it, and Cody can send it the other way (reroute): a forward still queued is taken back.
import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { Config } from "./config.js"
import type { Hub } from "./hub.js"
import type { Store } from "./store.js"
import { BadRequestError, ConflictError, NotFoundError } from "./store.js"
import type { SettingsStore } from "./settings.js"
import type { McpCaller } from "./mcp.js"
import { listCompactions, readCompactionInfo, summaryBody } from "./compactions.js"
import { resultUsageObject, sessionUsageOf } from "./usage.js"
import { serverClaudeEnv } from "./turnCredentials.js"
import { rotationLoginRef, type AgentLogins, type PickedLogin } from "./agentLogins.js"
import { isCredentialsLogin } from "../shared/agentLogins.js"
import { MISSING_SESSION, codexErrorText } from "./codex.js"
import { CHAT_ALLOWED_TOOLS, CHAT_TOOLS, chatClaudeLogin, codexChatLaunch, type ChatLaunch, type OwnClaudeLogin } from "./chatAgent.js"
import { limitsOf, recordLimits } from "./loginLimits.js"
import type { AgentCli } from "../shared/agentCli.js"
import { withOwner } from "../shared/owner.js"
import { parseNextSteps } from "../shared/nextSteps.js"
import type { ChatMessage, Effort, Settings, SideThread, SideThreadKind, SideThreadMessage, Task } from "../shared/types.js"
import { mayBeDirective, parseRouteDirective, routeMeta, routeOf, type RerouteTarget } from "../shared/threadRoutes.js"

const TURN_TIMEOUT_MS = 10 * 60_000
/** The most of a highlight or question a thread keeps. */
export const MAX_QUOTE_CHARS = 20_000
export const MAX_QUESTION_CHARS = 20_000
/** The summary fallback replays at most this many messages, each cut to this many characters. */
const FALLBACK_MESSAGES = 30
const FALLBACK_MESSAGE_CHARS = 1500
/** A task thread starts with at most this many of the task's updates in the chat. */
const TASK_NOTICES = 12

/**
 * The Box Yard tools a side thread may call: lookups that change nothing. Every other tool is listed (the fork keeps
 * the chat's tool list, and with it the prompt cache) but refused, by the CLI and by the MCP server.
 */
export const THREAD_TOOLS: ReadonlySet<string> = new Set([
  "list_projects",
  "list_tasks",
  "get_task",
  "search_history",
  "list_compactions",
  "compaction_history",
  "read_compaction",
  "find_compactions_by_task",
  "list_inbox",
  "list_queued_messages",
  "list_artifacts",
  "read_artifact",
  "list_notes",
  "list_note_suggestions",
  "list_schedules",
  "list_schedule_runs",
  "list_hooks",
  "list_hook_runs",
  "pool_status",
  "machine_stats",
  "list_machines",
  "box_history",
  "turn_timings",
  "get_settings",
  // A Captain's read-only clone of its repo: the fetch is Box Yard's own, and the thread only reads the code.
  "repo_clone",
])

/** What the MCP server answers a side thread that calls any other tool. */
export const READ_ONLY_REFUSAL =
  "Side threads are read-only: this tool changes Box Yard, so it isn't available here. Say what you would do, and Cody can ask for it in the main chat."

/** Chat message meta naming the Claude session line an assistant message came from: where a side thread forks. */
export const SESSION_UUID_KEY = "sessionUuid"
export const SESSION_ID_KEY = "sessionId"

/** The meta an assistant chat message keeps so a side thread can fork the session at it. */
export function sessionLineMeta(line: { uuid?: unknown }, sessionId: string): Record<string, string> {
  return typeof line.uuid === "string" && line.uuid ? { [SESSION_UUID_KEY]: line.uuid, [SESSION_ID_KEY]: sessionId } : {}
}

/** What a chat lends its side threads. */
export interface ThreadHost {
  /** The chat's working folder: its Claude sessions are stored by it, so a fork must run there too. */
  cwd: string
  /** The chat's current session. */
  session(): { id: string; started: boolean }
  /** The chat's system prompt, unchanged, so a fork reuses its prompt cache. */
  systemPrompt(): string
  /** Read rules for the chat's own folders (compaction logs, uploads, a Captain's clone of its repo). */
  readRules(): string[]
  /** The chat's built-in tools (--tools), so the fork keeps its prompt cache; CHAT_TOOLS when unset. */
  tools?: string
  /** The chat's deny rules (--disallowedTools): a Captain's clone takes no edits. */
  denyRules?(): string[]
  /** The CLI the chat runs on now: a thread runs on it too. */
  cli(): AgentCli
  /** The chat's model on that CLI (null: Codex's own default). */
  model(): string | null
  effort(): string
  compactionsDir: string
  /** The chat's MCP caller; the thread gets a read-only one like it. */
  caller: McpCaller
  /** The chat's own Claude login (a Captain's project identity's), or null for Settings › Credentials'. */
  claudeLogin(): OwnClaudeLogin | null
  /** The rotation's login the chat runs on now (docs/logins.md): its threads run on it too. Null: the usual login. */
  login?(): PickedLogin | null
  /** How its runs are counted in usage. */
  usage: { source: "orchestrator" | "captain"; projectId: string | null }
  /**
   * These tasks as they stand now (status, PR, question, last reply), as the chat may see them: a task thread starts
   * from it. Only the Coordinator's chat has task threads.
   */
  taskState?(task: Task): Promise<string>
  /** The project shows the chat its tasks' status only (docs/identities.md): a task thread gets none of their updates. */
  statusOnly?(projectId: string): boolean
}

/**
 * The chat's host with Settings › Coordinator › Quick questions applied: the thread's model and effort, each one its
 * chat's when the setting is "" (the default). Only on Claude: a thread on a Codex chat runs on Codex, as its chat does.
 * Another model or effort than the chat's can't read its prompt cache, so such a thread's first turn writes it anew.
 */
export function quickQuestionHost(host: ThreadHost, s: Pick<Settings, "quickQuestionModel" | "quickQuestionEffort">): ThreadHost {
  if (host.cli() !== "claude" || (!s.quickQuestionModel && !s.quickQuestionEffort)) return host
  const model = s.quickQuestionModel || host.model()
  const effort = s.quickQuestionEffort || host.effort()
  return { ...host, model: () => model, effort: () => effort }
}

/** Where a fork starts: the session line of the newest assistant message at or before the highlighted one. */
export interface ForkPoint {
  uuid: string
  /** The highlighted message is that assistant message (else its text goes in the prompt). */
  atAnchor: boolean
}

/**
 * Where to fork `messages` (a chat up to and including the highlighted message, oldest first): the newest assistant
 * message from the chat's current session that carries its session line. null, so the thread falls back to the
 * summary, when there is none, or when the chat was compacted after it (a fork there would replay the whole
 * pre-compaction history).
 */
export function forkPoint(messages: ChatMessage[], sessionId: string, lastCompactionAt: number | null): ForkPoint | null {
  const anchor = messages.at(-1)
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== "assistant") continue
    const uuid = m.meta?.[SESSION_UUID_KEY]
    if (typeof uuid !== "string" || m.meta?.[SESSION_ID_KEY] !== sessionId) return null
    if (lastCompactionAt !== null && m.createdAt <= lastCompactionAt) return null
    return { uuid, atAnchor: m === anchor }
  }
  return null
}

/**
 * The fallback context: the summary of the newest compaction at or before the highlighted message, then the
 * conversation from that compaction up to and including the highlighted message (never anything after it).
 */
export function summaryContext(messages: ChatMessage[], summary: { at: number; markdown: string } | null, ownerName?: string, upTo = "the highlighted message"): string {
  const since = summary?.at ?? 0
  const lines = messages
    .filter((m) => m.createdAt >= since && (m.role === "user" || m.role === "assistant" || m.role === "notice") && m.meta?.cancelled !== true && m.content.trim())
    .slice(-FALLBACK_MESSAGES)
    .map((m) => {
      const who = m.role === "user" ? withOwner("Cody", ownerName) : m.role === "assistant" ? "You" : "Box Yard update"
      const text = m.content.length > FALLBACK_MESSAGE_CHARS ? `${m.content.slice(0, FALLBACK_MESSAGE_CHARS)}…` : m.content
      return `[${who}] ${text}`
    })
  return [
    summary ? `The summary you wrote when the chat was compacted, before ${upTo}:\n${summaryBody(summary.markdown)}` : null,
    lines.length ? `The conversation${summary ? " since then" : ""}, up to and including ${upTo}:\n${lines.join("\n\n")}` : null,
  ]
    .filter(Boolean)
    .join("\n\n")
}

const quoteBlock = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => `> ${l}`)
    .join("\n")

/** A side thread's first prompt: the highlight and the question, with the context a fresh session needs. */
export function threadPrompt(o: {
  quote: string
  question: string
  anchorText: string | null
  context: string | null
  ownerName?: string
  /** The highlight is in this task's transcript, not in the chat. */
  task?: { id: string; title: string } | null
}): string {
  const own = (t: string) => withOwner(t, o.ownerName)
  return [
    own(
      o.task
        ? `[Box Yard side thread] Cody highlighted a passage in the transcript of the task "${o.task.title}" (${o.task.id}), one of this project's, and is asking about it in a side thread. The thread is separate from the main conversation: the main chat never sees it. The passage is the task's agent's output or a message to it, not something you said; get_task reads the task as it stands.`
        : "[Box Yard side thread] Cody highlighted a passage in this chat and is asking about it in a side thread. The thread is separate from the main conversation: the main chat never sees it, and it starts at the highlighted message, so nothing said after that message is part of it.",
    ),
    o.context ? `[Your session for this thread was started fresh, from your notes.]\n\n${o.context}` : null,
    o.anchorText ? `The highlighted passage is from this message:\n${quoteBlock(o.anchorText)}` : null,
    `Highlighted:\n${quoteBlock(o.quote)}`,
    own(
      "Answer briefly and directly. This thread is read-only: you may look things up (get_task, list_tasks, search_history, read_artifact and the other list_, get_ and read_ tools), but nothing that changes Box Yard works here (no create_task, send_to_task, schedules, settings or other changes). If Cody wants something done, say what you would do; Cody can ask for it in the main chat. No next-step block in this thread.",
    ),
    `${own("Cody")}'s question:\n${o.question}`,
  ]
    .filter(Boolean)
    .join("\n\n")
}

/**
 * A nested thread's first prompt: a passage highlighted inside another thread (its parent) and the question. A fork of
 * the parent's session already has the parent; a fresh session gets it as `context` (parentTranscript).
 */
export function nestedPrompt(o: { quote: string; question: string; context: string | null; ownerName?: string }): string {
  const own = (t: string) => withOwner(t, o.ownerName)
  return [
    own(
      "[Box Yard side thread] Cody highlighted a passage in a side thread of this chat and is asking about it in a thread of its own, nested under that one. It is separate from the main conversation and from the thread it came from: neither sees what is said here.",
    ),
    o.context ? `[Your session for this thread was started fresh, from your notes.]\n\n${o.context}` : null,
    `Highlighted:\n${quoteBlock(o.quote)}`,
    own(`Answer briefly and directly, here: don't send it on anywhere. ${NESTED_READ_ONLY}`),
    `${own("Cody")}'s question:\n${o.question}`,
  ]
    .filter(Boolean)
    .join("\n\n")
}

const NESTED_READ_ONLY =
  "This thread is read-only: you may look things up (get_task, list_tasks, search_history, read_artifact and the other list_, get_ and read_ tools), but nothing that changes Box Yard works here (no create_task, send_to_task, schedules, settings or other changes). If Cody wants something done, say what you would do; Cody can ask for it in the main chat. No next-step block in this thread."

/** The thread a nested one was asked from, for a session that can't fork it: what it started on, then what was said (cut like the chat's replay). */
export function parentTranscript(parent: Pick<SideThread, "kind" | "quote">, messages: SideThreadMessage[], ownerName?: string): string {
  const lines = messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim())
    .slice(-FALLBACK_MESSAGES)
    .map((m) => `[${m.role === "user" ? withOwner("Cody", ownerName) : "You"}] ${m.content.length > FALLBACK_MESSAGE_CHARS ? `${m.content.slice(0, FALLBACK_MESSAGE_CHARS)}…` : m.content}`)
  const start = parent.quote.length > FALLBACK_MESSAGE_CHARS * 2 ? `${parent.quote.slice(0, FALLBACK_MESSAGE_CHARS * 2)}…` : parent.quote
  return [
    `The thread the passage was highlighted in started from ${parent.kind === "reply" ? "this message" : parent.kind === "task" ? "the card of this task" : "this highlighted passage"}:\n${quoteBlock(start)}`,
    lines.length ? `That thread so far:\n${lines.join("\n\n")}` : null,
  ]
    .filter(Boolean)
    .join("\n\n")
}

/**
 * A reply thread's first prompt: the message Cody replied to, in full (the thread's context starts there), and the
 * reply. Like an ask's, with the whole message instead of a highlight. `rules`: how to route it (routeRules), or
 * that Cody asked for it to be answered here (ANSWER_HERE); without them, a plain read-only answer.
 */
export function replyPrompt(o: { original: string; reply: string; context: string | null; ownerName?: string; rules?: string | null }): string {
  const own = (t: string) => withOwner(t, o.ownerName)
  return [
    own(
      "[Box Yard side thread] Cody replied to one of the messages in this chat, in a thread under it. The thread is separate from the main conversation: the main chat never sees it, and it starts at that message, so nothing said after it is part of it.",
    ),
    o.context ? `[Your session for this thread was started fresh, from your notes.]\n\n${o.context}` : null,
    `${own("The message Cody is replying to:")}\n${quoteBlock(o.original)}`,
    o.rules
      ? o.rules
      : own(
          "Answer the reply in light of that message, briefly and directly. This thread is read-only: you may look things up (get_task, list_tasks, search_history, read_artifact and the other list_, get_ and read_ tools), but nothing that changes Box Yard works here (no create_task, send_to_task, schedules, settings or other changes). If Cody wants something done, say what you would do; Cody can ask for it in the main chat. No next-step block in this thread.",
        ),
    `${own("Cody")}'s reply:\n${o.reply}`,
  ]
    .filter(Boolean)
    .join("\n\n")
}

/**
 * How a reply thread's turn routes Cody's messages (shared/threadRoutes.ts): answer, or one directive Box Yard acts
 * on. `task`: the message the thread is under is about this task, so its agent is a route too. Every routed turn
 * gets these again: a thread from before routing never had them.
 */
export function routeRules(o: { task: { id: string; title: string } | null; ownerName?: string }): string {
  const own = (t: string) => withOwner(t, o.ownerName)
  return [
    own("Route each of Cody's messages in this thread. Decide what it is:"),
    own("- A question, or anything you can answer from what you know or can look up: answer it here, briefly and directly."),
    o.task
      ? `- An instruction or feedback for the agent working on the task "${o.task.title}" (${o.task.id}): what to change, fix or try, an answer to its question, a go-ahead. Reply with only [[route:agent]]. ${own("Box Yard sends Cody's words to that agent unchanged.")}`
      : null,
    own(
      "- Something only your main chat can do: start, split, stop, merge or reprioritise tasks, a message to another task, settings, schedules. Reply with only [[route:chat]]. Box Yard posts it in your main chat, where you act on it with all your tools.",
    ),
    own("If you aren't sure, answer here and end with one short line offering to send it on. Cody sees where each message went and can send it the other way with one tap."),
    own(
      "Either way, this thread is read-only: you may look things up (get_task, list_tasks, search_history, read_artifact and the other list_, get_ and read_ tools), but nothing that changes Box Yard works here. No next-step block in this thread.",
    ),
  ]
    .filter(Boolean)
    .join("\n")
}

/** A reply thread's turn for messages Cody sent back to be answered here (reroute): no routing this time. */
export function answerHere(ownerName?: string): string {
  return withOwner(
    "[Cody chose to have this answered here in the thread rather than sent on: answer it, briefly and directly, and don't route it. This thread is read-only: look things up, but change nothing. No next-step block.]",
    ownerName,
  )
}

/** A later turn's prompt in a reply thread: the rules (or answerHere) again, then Cody's messages. */
export function routedTurnPrompt(o: { reply: string; rules: string; ownerName?: string }): string {
  return `${o.rules}\n\n${withOwner("Cody", o.ownerName)}'s reply:\n${o.reply}`
}

/** What a main chat gets when a reply thread sends a message there: the start of the message it replies to, quoted, then Cody's words. */
export function chatForward(original: string, content: string): string {
  // The chat shows Cody's messages as plain text, so the quote drops bold markers (a notice's **title**).
  const text = original.replace(/\*\*|__/g, "").trim()
  const excerpt = text.length > 280 ? `${text.slice(0, 280).trimEnd()}…` : text
  return excerpt ? `${quoteBlock(excerpt)}\n\n${content}` : content
}

/** The read-only rule every thread's first prompt ends with. */
const READ_ONLY_RULE =
  "This thread is read-only: you may look things up (get_task, list_tasks, search_history, read_artifact and the other list_, get_ and read_ tools), but nothing that changes Box Yard works here (no create_task, send_to_task, schedules, settings or other changes). If Cody wants something done, say what you would do; Cody can ask for it in the main chat or send it to the task from its card. No next-step block in this thread."

/** A task's updates in the chat, oldest first, one line each (cut), for a task thread's first prompt. */
export function noticeLines(notices: ChatMessage[]): string {
  return notices
    .filter((m) => m.content.trim())
    .map((m) => `- ${m.content.length > FALLBACK_MESSAGE_CHARS ? `${m.content.slice(0, FALLBACK_MESSAGE_CHARS)}…` : m.content}`)
    .join("\n")
}

/**
 * A task thread's first prompt: which card Cody asks from, the task as it stands now, its updates in the chat, and the
 * question. `context`: a fresh session's notes, when the chat's session couldn't be forked.
 */
export function taskThreadPrompt(o: { title: string; state: string; notices: string; question: string; context: string | null; ownerName?: string }): string {
  const own = (t: string) => withOwner(t, o.ownerName)
  return [
    `[Box Yard side thread] ${own("Cody")} is asking you about a task, from the card of the task "${o.title}" in the Coordinator chat. This thread is separate from the main conversation: the main chat never sees it, and it starts at your newest message there.`,
    o.context ? `[Your session for this thread was started fresh, from your notes.]\n\n${o.context}` : null,
    o.state,
    o.notices ? `Its updates in the chat, oldest first:\n${o.notices}` : null,
    own(`Answer briefly and directly, about this task. ${READ_ONLY_RULE}`),
    `${own("Cody")}'s question:\n${o.question}`,
  ]
    .filter(Boolean)
    .join("\n\n")
}

/**
 * What a task thread's state says, without its "updated 3m ago"s: a later turn is told the state again only when this
 * changed, not because a minute passed.
 */
export function taskKey(t: Task): string {
  return JSON.stringify([t.id, t.status, t.updatedAt, t.prUrl ?? null, t.prState ?? null, t.pendingCount ?? 0, t.question ?? null, t.error ?? null])
}

/** How a reply thread delivers the messages it routes. app.ts wires it to the task queue and the chats. */
export interface ThreadRouter {
  /** Cody's message to a task's agent, as from its card: queued for the agent, with the "got a message" line in the chat. */
  toAgent(taskId: string, content: string): Promise<{ inputId: string }>
  /** Take a queued message back before the agent reads it; false once it has. */
  recallAgent(taskId: string, inputId: string): boolean
  /** Cody's message in a main chat (the Coordinator's for null, else the project's Captain's), for a turn there. */
  toChat(projectId: string | null, content: string): { messageId: string }
  /** Take a chat message back before a turn reads it; false once one has. */
  recallChat(projectId: string | null, messageId: string): boolean
}

interface RunState {
  child: ChildProcess | null
  running: boolean
  pending: boolean
  /** The last user message a turn has taken: the next turn takes the ones after it. */
  lastAskId: string | null
  /** A task thread's: the task's state as its last turn was told it (taskKey). */
  taskKey?: string
  /** A reply thread's messages Cody sent back to be answered here (reroute), for the next turn. */
  forced: string[]
  /** The route the running turn asked for (`[[route:agent]]`), if it did. */
  directive: "agent" | "chat" | null
}

interface RunResult {
  ok: boolean
  error: string
  /** The run stopped before the CLI started a session (a fork it couldn't make). */
  noSession: boolean
}

export class SideThreads {
  private readonly runs = new Map<string, RunState>()
  /** Read-only MCP tokens, one per chat ("coordinator" or a project id). */
  private readonly tokens = new Map<string, { token: string; caller: McpCaller }>()
  private stopped = false
  private readonly dir: string
  /** The Claude and Codex logins (docs/logins.md): a thread reports how its chat's login did. app.ts wires them in. */
  logins: AgentLogins | null = null
  /** Where a reply thread sends what it routes. Without one (tests), reply threads only answer. */
  router: ThreadRouter | null = null

  constructor(
    private readonly c: Config,
    private readonly store: Store,
    private readonly hub: Hub,
    private readonly settings: SettingsStore,
    private readonly mcpUrl: string,
    /** The chat a thread belongs to: the Coordinator for null, else that project's Captain. */
    private readonly hostFor: (projectId: string | null) => ThreadHost,
  ) {
    this.dir = path.join(c.dataDir, "side-threads")
    fs.mkdirSync(this.dir, { recursive: true })
  }

  /** The read-only caller a side thread's MCP token stands for, or null for any other token. */
  callerForToken(token: string): McpCaller | null {
    for (const t of this.tokens.values()) if (t.token === token) return { ...t.caller, readOnly: true } as McpCaller
    return null
  }

  list(projectId: string | null): SideThread[] {
    this.checkChat(projectId)
    return this.store.listSideThreads(projectId).map((t) => this.decorate(t))
  }

  get(id: string): SideThread {
    const t = this.store.getSideThread(id)
    if (!t) throw new NotFoundError(`Side thread ${id} not found`)
    return this.decorate(t)
  }

  messages(id: string): SideThreadMessage[] {
    this.get(id)
    return this.store.listSideThreadMessages(id)
  }

  /**
   * Open a thread on a chat message with Cody's first message: a question about a highlighted passage (kind "ask"),
   * or a reply to the whole message (kind "reply", no quote needed). A message has one reply thread: replying to it
   * again adds to that thread. Kind "task": a question from a task's card in the Coordinator chat (anchorId: the
   * task's id); a card has one thread too. An ask in a Captain's chat may be anchored on one of its project's tasks
   * instead of a message: a passage of that task's transcript. `parentId`: an ask from inside another thread of the
   * chat, about a passage of it (nested, to any depth); it takes its parent's anchor.
   */
  create(input: { projectId: string | null; anchorId: string; quote?: string; question: string; kind?: SideThreadKind; id?: string; messageId?: string; parentId?: string | null }): {
    thread: SideThread
    message: SideThreadMessage
  } {
    this.checkChat(input.projectId)
    const kind = input.kind ?? "ask"
    const question = input.question.trim()
    if (!question) throw new BadRequestError(kind === "reply" ? "question: write a reply" : "question: ask something")
    if (input.parentId) return this.createNested({ ...input, parentId: input.parentId }, question)
    if (kind === "task") return this.createOnCard(input, question)
    const anchor = this.store.chatUpTo(input.projectId, input.anchorId, 1)?.[0]
    const onTask = !anchor && kind === "ask" && input.projectId ? this.store.getTask(input.anchorId) : null
    if (!anchor && onTask?.projectId !== input.projectId) throw new BadRequestError(`anchorId: no message ${input.anchorId} in this chat`)
    if (kind === "reply") {
      const existing = this.store.threadOn(input.projectId, input.anchorId, "reply")
      if (existing) {
        const message = this.send(existing.id, question, input.messageId)
        return { thread: this.get(existing.id), message }
      }
    }
    const quote = (kind === "reply" ? (anchor?.content ?? "") : (input.quote ?? "")).trim()
    if (!quote) throw new BadRequestError(kind === "reply" ? "anchorId: that message has no text to reply to" : "quote: highlight some text to ask about")
    if (input.id && this.store.getSideThread(input.id)) throw new BadRequestError(`A side thread ${input.id} already exists`)
    const thread = this.store.createSideThread({ id: input.id, projectId: input.projectId, anchorId: input.anchorId, kind, quote: quote.slice(0, MAX_QUOTE_CHARS), sessionId: randomUUID() })
    this.hub.broadcast({ type: "thread", thread: this.decorate(thread) })
    const message = this.send(thread.id, question, input.messageId)
    return { thread: this.get(thread.id), message }
  }

  /** A thread under another one: an ask about a passage of the parent's messages. */
  private createNested(input: { projectId: string | null; parentId: string; quote?: string; id?: string; messageId?: string }, question: string) {
    const parent = this.store.getSideThread(input.parentId)
    if (!parent || parent.projectId !== input.projectId) throw new BadRequestError(`parentId: no thread ${input.parentId} in this chat`)
    const quote = (input.quote ?? "").trim()
    if (!quote) throw new BadRequestError("quote: highlight some text to ask about")
    if (input.id && this.store.getSideThread(input.id)) throw new BadRequestError(`A side thread ${input.id} already exists`)
    const thread = this.store.createSideThread({ id: input.id, projectId: parent.projectId, anchorId: parent.anchorId, kind: "ask", parentId: parent.id, quote: quote.slice(0, MAX_QUOTE_CHARS), sessionId: randomUUID() })
    this.hub.broadcast({ type: "thread", thread: this.decorate(thread) })
    const message = this.send(thread.id, question, input.messageId)
    return { thread: this.get(thread.id), message }
  }

  /** A task card's thread: its first question, or the next one in the thread it has. */
  private createOnCard(input: { projectId: string | null; anchorId: string; id?: string; messageId?: string }, question: string) {
    if (input.projectId) throw new BadRequestError("kind: only the Coordinator chat has task cards")
    const task = this.store.getTask(input.anchorId)
    if (!task) throw new BadRequestError(`anchorId: no task ${input.anchorId}`)
    const existing = this.store.threadOn(null, input.anchorId, "task")
    if (existing) {
      const message = this.send(existing.id, question, input.messageId)
      return { thread: this.get(existing.id), message }
    }
    if (input.id && this.store.getSideThread(input.id)) throw new BadRequestError(`A side thread ${input.id} already exists`)
    const thread = this.store.createSideThread({ id: input.id, projectId: null, anchorId: input.anchorId, kind: "task", quote: task.title.slice(0, MAX_QUOTE_CHARS), sessionId: randomUUID() })
    this.hub.broadcast({ type: "thread", thread: this.decorate(thread) })
    const message = this.send(thread.id, question, input.messageId)
    return { thread: this.get(thread.id), message }
  }

  /** Cody's next message in a thread; answered right away, or after the turn that's running. It reopens a resolved thread. */
  send(id: string, content: string, messageId?: string): SideThreadMessage {
    const thread = this.get(id)
    const text = content.trim().slice(0, MAX_QUESTION_CHARS)
    if (!text) throw new BadRequestError("content: message is empty")
    const message = this.store.addSideThreadMessage(thread.id, "user", text, null, messageId)
    if (thread.resolvedAt !== null) this.store.resolveSideThread(thread.id, false)
    this.store.seeSideThread(thread.id, message.createdAt)
    this.hub.broadcast({ type: "thread.message", message })
    this.state(thread.id).pending = true
    void this.drain(thread.id)
    return message
  }

  /** Resolve a thread (it folds away under its message, still reachable there), or reopen it. */
  resolve(id: string, resolved: boolean): SideThread {
    this.get(id)
    this.store.resolveSideThread(id, resolved)
    this.publish(id)
    return this.get(id)
  }

  /** Cody has the thread open: its answers so far are read. */
  seen(id: string): SideThread {
    const before = this.get(id)
    this.store.seeSideThread(id)
    const after = this.get(id)
    if (before.unread !== after.unread) this.publish(id)
    return after
  }

  stop(id: string) {
    this.runs.get(id)?.child?.kill("SIGTERM")
  }

  /** A thread goes with the threads asked from inside it. */
  delete(id: string) {
    const thread = this.get(id)
    for (const child of this.store.childSideThreads(id)) this.delete(child.id)
    const run = this.runs.get(id)
    if (run) {
      run.pending = false
      run.child?.kill("SIGTERM")
    }
    this.runs.delete(id)
    this.store.deleteSideThread(id)
    this.hub.broadcast({ type: "thread.deleted", threadId: id, projectId: thread.projectId })
  }

  /** Box Yard is shutting down: stop every run before the database closes. */
  stopAll() {
    this.stopped = true
    for (const r of this.runs.values()) r.child?.kill("SIGTERM")
  }

  get anyBusy() {
    return [...this.runs.values()].some((r) => r.running)
  }

  private checkChat(projectId: string | null) {
    if (projectId && !this.store.getProject(projectId)) throw new NotFoundError(`Project ${projectId} not found`)
  }

  private decorate(t: SideThread): SideThread {
    return { ...t, busy: Boolean(this.runs.get(t.id)?.running), taskId: t.kind === "reply" ? this.store.chatMessageTaskId(t.projectId, t.anchorId) : null }
  }

  private state(id: string): RunState {
    let r = this.runs.get(id)
    if (!r) {
      // After a restart, what came before the thread's last reply was answered.
      let lastAskId: string | null = null
      let answered: string | null = null
      for (const m of this.store.listSideThreadMessages(id)) {
        if (m.role === "user") lastAskId = m.id
        else answered = lastAskId
      }
      r = { child: null, running: false, pending: false, lastAskId: answered, forced: [], directive: null }
      this.runs.set(id, r)
    }
    return r
  }

  private publish(id: string) {
    try {
      const t = this.store.getSideThread(id)
      if (t) this.hub.broadcast({ type: "thread", thread: this.decorate(t) })
    } catch {
      // The database is closed (shutdown while a run was finishing).
    }
  }

  private async drain(id: string) {
    const r = this.state(id)
    if (r.running || this.stopped) return
    r.running = true
    this.publish(id)
    try {
      while ((r.pending || r.forced.length) && !this.stopped && this.runs.get(id) === r) {
        // Messages Cody sent back to be answered here go first, in a turn of their own (no routing in it).
        if (r.forced.length) await this.turn(id, r, r.forced.splice(0))
        else {
          r.pending = false
          await this.turn(id, r)
        }
      }
    } catch (err) {
      if (!this.stopped) throw err
    } finally {
      r.running = false
      if (!this.stopped) this.publish(id)
    }
  }

  /** `forced`: messages Cody sent back to be answered here (reroute), instead of the ones no turn has taken yet. */
  private async turn(id: string, r: RunState, forced?: string[]) {
    const thread = this.store.getSideThread(id)
    if (!thread) return
    const list = this.store.listSideThreadMessages(id)
    let asks: SideThreadMessage[]
    if (forced) asks = list.filter((m) => m.role === "user" && forced.includes(m.id))
    else {
      asks = list.slice(list.findIndex((m) => m.id === r.lastAskId) + 1).filter((m) => m.role === "user")
      if (asks.length) r.lastAskId = asks.at(-1)!.id
    }
    if (!asks.length) return
    const question = asks.map((m) => m.content).join("\n\n")
    const settings = this.settings.get()
    const host = quickQuestionHost(this.hostFor(thread.projectId), settings)
    const session = this.store.sideThreadSession(id)!
    const owner = settings.ownerName

    if (thread.kind === "task") return this.taskTurn(id, r, thread, host, question, session, owner)
    // A reply thread routes what Cody sends (or, for what Cody sent back, just answers it).
    const taskId = thread.kind === "reply" && this.router ? this.store.chatMessageTaskId(thread.projectId, thread.anchorId) : null
    const task = taskId ? this.store.getTask(taskId) : null
    const routing = thread.kind === "reply" && this.router ? (forced ? "answer" : "route") : null
    const rules = routing === "route" ? routeRules({ task: task ? { id: task.id, title: task.title } : null, ownerName: owner }) : routing === "answer" ? answerHere(owner) : null
    r.directive = null
    const result = await this.answer(id, r, thread, host, question, session, owner, rules)
    if (!result) return
    this.finish(id, result)
    if (routing) await this.settle(id, r, asks, result, routing, task?.id ?? null)
  }

  /** A reply or ask thread's turn: resume its session, or fork the chat's at the message, or start fresh from its summary. */
  private async answer(
    id: string,
    r: RunState,
    thread: SideThread,
    host: ThreadHost,
    question: string,
    session: { sessionId: string; started: boolean },
    owner: string | undefined,
    rules: string | null,
  ): Promise<RunResult | null> {
    const routes = rules !== null
    const gone = () => this.stopped || !this.store.getSideThread(id)
    if (session.started) {
      const prompt = rules ? routedTurnPrompt({ reply: question, rules, ownerName: owner }) : question
      const result = await this.run(id, r, host, prompt, ["--resume", session.sessionId], session.sessionId, true, undefined, routes)
      // Its session is gone, or belongs to the CLI the chat ran on before: start over from the summary.
      if (result.ok || !MISSING_SESSION.test(result.error) || gone()) return gone() ? null : result
    }

    // Asked from inside another thread: it starts from that thread, not from the chat.
    const parent = thread.parentId ? this.store.getSideThread(thread.parentId) : null
    if (parent) {
      const from = this.store.sideThreadSession(parent.id)
      const nested = (context: string | null) => nestedPrompt({ quote: thread.quote, question, context, ownerName: owner })
      // The parent's session as it stands (never while a turn of its own is writing it). Codex can't fork one.
      if (from?.started && host.cli() === "claude" && !this.runs.get(parent.id)?.running) {
        const args = ["--resume", from.sessionId, "--fork-session", "--session-id", session.sessionId]
        const result = await this.run(id, r, host, nested(null), args, session.sessionId, true, "fork", routes)
        if (result.ok || !result.noSession || gone()) return gone() ? null : result
      }
      const context = parentTranscript(parent, this.store.listSideThreadMessages(parent.id), owner)
      const fresh = randomUUID()
      const result = await this.run(id, r, host, nested(context), ["--session-id", fresh], fresh, false, "summary", routes)
      return gone() ? null : result
    }

    const inChat = this.store.chatUpTo(thread.projectId, thread.anchorId, 400)
    // An ask about a passage of a task's transcript (a Captain's chat): there's no message to start at, so it starts
    // at the Captain's newest one.
    const task = !inChat && thread.kind === "ask" && thread.projectId ? this.store.getTask(thread.anchorId) : null
    const upTo: ChatMessage[] = inChat ?? (task && thread.projectId ? this.store.listCaptainMessages(thread.projectId, 400) : [])
    const main = host.session()
    const compactions = this.compactionsFor(host)
    // Codex can't fork a session at a message: a thread on a Codex chat always starts from the summary.
    const fork = main.started && host.cli() === "claude" ? forkPoint(upTo, main.id, compactions.at(-1)?.at ?? null) : null
    const anchor = task ? undefined : upTo.at(-1)
    // A reply thread quotes the whole message it replies to; an ask, the highlight (and the message, unless the fork ends on it).
    const first = (context: string | null, withAnchor: boolean) =>
      thread.kind === "reply"
        ? replyPrompt({ original: anchor?.content || thread.quote, reply: question, context, ownerName: owner, rules })
        : threadPrompt({ quote: thread.quote, question, anchorText: withAnchor ? (anchor?.content ?? null) : null, context, ownerName: owner, task: task ? { id: task.id, title: task.title } : null })
    if (fork) {
      const prompt = first(null, !fork.atAnchor)
      const args = ["--resume", main.id, "--resume-session-at", fork.uuid, "--fork-session", "--session-id", session.sessionId]
      const result = await this.run(id, r, host, prompt, args, session.sessionId, true, "fork", routes)
      // A fork the CLI couldn't make (the session file is gone, say): start over from the summary.
      if (result.ok || !result.noSession || gone()) return gone() ? null : result
    }
    const summary = this.summaryBefore(compactions, anchor?.createdAt ?? Date.now())
    const context = summaryContext(upTo, summary, owner, task ? "your newest message" : undefined)
    const prompt = first(context || null, false)
    const fresh = randomUUID()
    const result = await this.run(id, r, host, prompt, ["--session-id", fresh], fresh, false, "summary", routes)
    return gone() ? null : result
  }

  /**
   * After a reply thread's turn: each of Cody's messages it took gets its route. The turn's directive sends them on,
   * one by one and word for word; an answer marks them answered here; an error marks them failed, so the thread
   * offers to send or ask again (a message is never dropped).
   */
  private async settle(id: string, r: RunState, asks: SideThreadMessage[], result: RunResult, routing: "route" | "answer", taskId: string | null) {
    const thread = this.store.getSideThread(id)
    if (!thread || this.stopped) return
    if (routing === "route" && r.directive) {
      const to = r.directive === "agent" && taskId ? "agent" : "chat"
      for (const m of asks) await this.forward(thread, this.store.getSideThreadMessage(m.id) ?? m, to, "router", taskId).catch(() => {})
      return
    }
    for (const m of asks) {
      const prev = routeOf(this.store.getSideThreadMessage(m.id)?.meta ?? m.meta)
      const by = routing === "answer" ? "cody" : "router"
      this.mark(m.id, routeMeta({ ...prev, route: result.ok ? "thread" : "failed", by }))
    }
  }

  /** Set a thread message's route and show it. */
  private mark(messageId: string, meta: Record<string, unknown>): SideThreadMessage {
    const message = this.store.patchSideThreadMessage(messageId, meta)
    if (!message) throw new NotFoundError(`Thread message ${messageId} not found`)
    this.hub.broadcast({ type: "thread.message", message })
    return message
  }

  /**
   * Send Cody's message on, word for word: to the task's agent, or into the thread's main chat (quoting the start of
   * the message it replies to). A forward it had to the other place is taken back first, while it's still queued.
   * If it can't be sent, the message says so and the thread offers to try again.
   */
  private async forward(thread: SideThread, m: SideThreadMessage, to: "agent" | "chat", by: "router" | "cody", taskId: string | null): Promise<SideThreadMessage> {
    const router = this.router
    if (!router) throw new BadRequestError("This thread can't send messages on.")
    const prev = routeOf(m.meta)
    const recalled = prev && !prev.recalled && prev.route !== to ? this.recall(thread, prev) : null
    try {
      if (to === "agent") {
        if (!taskId) throw new BadRequestError("This message isn't about a task, so there's no agent to send it to.")
        const { inputId } = await router.toAgent(taskId, m.content)
        return this.mark(m.id, routeMeta({ route: "agent", by, taskId, inputId }))
      }
      const anchor = this.store.chatUpTo(thread.projectId, thread.anchorId, 1)?.[0]
      const { messageId } = router.toChat(thread.projectId, chatForward(anchor?.content || thread.quote, m.content))
      return this.mark(m.id, routeMeta({ route: "chat", by, chatMessageId: messageId }))
    } catch (err) {
      if (this.store.getSideThread(thread.id)) {
        this.mark(m.id, routeMeta({ ...prev, route: "failed", by, recalled: recalled ?? prev?.recalled ?? false }))
        const where = to === "agent" ? "to the agent" : "to the main chat"
        const message = this.store.addSideThreadMessage(thread.id, "error", `Couldn't send it ${where}: ${(err as Error).message}`.slice(0, 1500))
        this.hub.broadcast({ type: "thread.message", message })
      }
      throw err
    }
  }

  /** Take a forward back while it's still queued: true when it was, false when its agent (or chat) already has it. */
  private recall(thread: SideThread, prev: NonNullable<ReturnType<typeof routeOf>>): boolean | null {
    const router = this.router
    if (!router) return null
    if (prev.route === "agent" && prev.taskId && prev.inputId) return router.recallAgent(prev.taskId, prev.inputId)
    if (prev.route === "chat" && prev.chatMessageId) return router.recallChat(thread.projectId, prev.chatMessageId)
    return null
  }

  /**
   * Cody sends one of a reply thread's messages the other way: to the task's agent, into the main chat, or back here
   * to be answered ("Just ask instead"; a forward still queued is taken back first). Refused while its turn is still
   * routing it.
   */
  async reroute(id: string, messageId: string, to: RerouteTarget): Promise<SideThreadMessage> {
    const thread = this.get(id)
    if (thread.kind !== "reply" || !this.router) throw new BadRequestError("Only a reply thread's messages can be sent on.")
    const m = this.store.getSideThreadMessage(messageId)
    if (!m || m.threadId !== id || m.role !== "user") throw new NotFoundError(`No message ${messageId} of yours in this thread`)
    const prev = routeOf(m.meta)
    const r = this.state(id)
    if (!prev && (r.running || r.pending)) throw new ConflictError("It's still being routed: wait for where it went, then send it the other way.")
    if (to !== "thread") {
      if (prev?.route === to && !prev.recalled) return m
      return this.forward(thread, m, to, "cody", thread.taskId ?? null)
    }
    if (prev?.route === "thread" || r.forced.includes(m.id)) return m
    const recalled = prev && !prev.recalled ? this.recall(thread, prev) : null
    const message = this.mark(
      m.id,
      routeMeta({ ...prev, route: "thread", by: "cody", recalled: recalled === true || (prev?.recalled ?? false), delivered: recalled === false || (prev?.delivered ?? false) }),
    )
    r.forced.push(m.id)
    void this.drain(id)
    return message
  }

  /**
   * A task card's turn. The first forks the Coordinator's session at its newest answer (or, when it can't, starts fresh
   * from the chat's last summary and messages) and starts from the task as it stands now and its updates in the chat.
   * Later turns resume the thread, with the task's state again when it changed.
   */
  private async taskTurn(
    id: string,
    r: RunState,
    thread: SideThread,
    host: ThreadHost,
    question: string,
    session: { sessionId: string; started: boolean },
    owner: string | undefined,
  ) {
    // An old batch card's thread (`batch:<id>`) has no task: like a deleted one's, it can't go on.
    const task = this.store.getTask(thread.anchorId)
    if (!task || !host.taskState) {
      this.finish(id, { ok: false, error: task ? "This chat has no task cards." : "Its task was deleted.", noSession: true })
      return
    }
    const state = await host.taskState(task)
    if (this.stopped || !this.store.getSideThread(id)) return
    const key = taskKey(this.store.getTask(task.id) ?? task)
    const changed = key !== r.taskKey
    r.taskKey = key

    if (session.started) {
      const prompt = changed ? `[The task now:]\n${state}\n\n${question}` : question
      const result = await this.run(id, r, host, prompt, ["--resume", session.sessionId], session.sessionId, true)
      // Its session is gone, or belongs to the CLI the chat ran on before: start over from the summary.
      if (result.ok || !MISSING_SESSION.test(result.error) || this.stopped || !this.store.getSideThread(id)) return this.finish(id, result)
    }

    const recent = this.store.listChat(400)
    const main = host.session()
    const compactions = this.compactionsFor(host)
    // Codex can't fork a session at a message: a thread on a Codex chat always starts from the summary.
    const fork = main.started && host.cli() === "claude" ? forkPoint(recent, main.id, compactions.at(-1)?.at ?? null) : null
    const notices = host.statusOnly?.(task.projectId) ? "" : noticeLines(this.store.taskNotices([task.id], TASK_NOTICES))
    const first = (context: string | null) => taskThreadPrompt({ title: task.title, state, notices, question, context, ownerName: owner })
    if (fork) {
      const args = ["--resume", main.id, "--resume-session-at", fork.uuid, "--fork-session", "--session-id", session.sessionId]
      const result = await this.run(id, r, host, first(null), args, session.sessionId, true, "fork")
      if (result.ok || !result.noSession || this.stopped || !this.store.getSideThread(id)) return this.finish(id, result)
    }
    // A fresh session replays the chat as the Coordinator read it: not Cody's messages straight to tasks (marked read
    // for it), nor a status-only project's updates.
    const sealed = (m: ChatMessage) => {
      const row = typeof m.meta?.taskId === "string" ? this.store.getTaskRow(m.meta.taskId) : null
      return Boolean(row && host.statusOnly?.(row.project_id))
    }
    const read = recent.filter((m) => m.role !== "notice" || (m.meta?.sent !== true && !sealed(m)))
    const summary = this.summaryBefore(compactions, Date.now())
    const context = summaryContext(read, summary, owner, "your newest message")
    const fresh = randomUUID()
    const result = await this.run(id, r, host, first(context || null), ["--session-id", fresh], fresh, false, "summary")
    this.finish(id, result)
  }

  private finish(id: string, result: RunResult) {
    if (result.ok || this.stopped || !this.store.getSideThread(id)) return
    const message = this.store.addSideThreadMessage(id, "error", `The side thread hit an error: ${result.error.slice(0, 1500)}`)
    this.hub.broadcast({ type: "thread.message", message })
    this.publish(id)
  }

  private compactionsFor(host: ThreadHost): { at: number; file: string }[] {
    if (host.caller.kind === "coordinator" && this.store.listProjects().some(p => host.statusOnly?.(p.id))) return []
    return this.compactions(host.compactionsDir)
  }

  /** A chat's compactions, oldest first: when, and the summary file. */
  private compactions(dir: string): { at: number; file: string }[] {
    return listCompactions(dir)
      .map((name) => {
        const file = path.join(dir, name)
        return { at: readCompactionInfo(file)?.at ?? 0, file }
      })
      .filter((x) => x.at > 0)
  }

  private summaryBefore(compactions: { at: number; file: string }[], at: number): { at: number; markdown: string } | null {
    const last = compactions.filter((x) => x.at <= at).at(-1)
    if (!last) return null
    try {
      return { at: last.at, markdown: fs.readFileSync(last.file, "utf8") }
    } catch {
      return null
    }
  }

  /** The chat's read-only MCP token, made on first use. */
  private tokenFor(host: ThreadHost): string {
    const key = host.usage.projectId ?? "coordinator"
    let t = this.tokens.get(key)
    if (!t) {
      t = { token: `thr_${randomBytes(24).toString("hex")}`, caller: host.caller }
      this.tokens.set(key, t)
    }
    return t.token
  }

  private mcpConfigFor(host: ThreadHost): string {
    const key = host.usage.projectId ?? "coordinator"
    const file = path.join(this.dir, `${key}-mcp.json`)
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { boxyard: { type: "http", url: this.mcpUrl, headers: { Authorization: `Bearer ${this.tokenFor(host)}` } } } }), { mode: 0o600 })
    return file
  }

  /**
   * How a thread's run starts: its chat's CLI. `sessionArgs` are Claude Code's (--resume, --fork-session…); on Codex
   * the run resumes `sessionId` when `resumed`, else starts a new thread, which names its own session.
   */
  private launch(host: ThreadHost, sessionArgs: string[], sessionId: string, resumed: boolean, login: PickedLogin | null): ChatLaunch {
    if (host.cli() === "codex") {
      return codexChatLaunch({
        c: this.c,
        credentials: login && this.logins ? this.logins.codexCredentials(login) : this.settings.credentials,
        loginId: login?.id ?? null,
        loginRef: rotationLoginRef(login),
        mcp: { url: this.mcpUrl, token: this.tokenFor(host) },
        resume: resumed ? sessionId : null,
        model: host.model(),
        effort: host.effort() as Effort,
        instructions: host.systemPrompt(),
      })
    }
    const allowed = [...[...THREAD_TOOLS].map((t) => `mcp__boxyard__${t}`), ...CHAT_ALLOWED_TOOLS, ...host.readRules()]
    const denied = host.denyRules?.() ?? []
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--strict-mcp-config",
      "--mcp-config",
      this.mcpConfigFor(host),
      // The chat's tools and system prompt, so the fork reuses its prompt cache; only the allowlist may run.
      "--tools",
      host.tools ?? CHAT_TOOLS,
      "--allowedTools",
      allowed.join(","),
      ...(denied.length ? ["--disallowedTools", denied.join(",")] : []),
      "--permission-mode",
      "dontAsk",
      "--append-system-prompt",
      host.systemPrompt(),
      ...sessionArgs,
      "--model",
      host.model() ?? "",
      "--effort",
      host.effort(),
    ]
    const [bin, ...pre] = this.c.claudeBin.split(" ")
    // Like its chat's own `claude`: the chat's Claude login, and never the key identities' secrets are encrypted with.
    const own = host.claudeLogin()
    const added = !own && login && !isCredentialsLogin(login.id) ? login : null
    const env = serverClaudeEnv(own?.env ?? added?.env ?? null, this.settings.credentials.claudeEnv())
    return { cli: "claude", bin: bin!, args: [...pre, ...args], env, translate: null, after() {}, login: rotationLoginRef(added) ?? chatClaudeLogin(env, own) }
  }

  private run(
    id: string,
    r: RunState,
    host: ThreadHost,
    prompt: string,
    sessionArgs: string[],
    sessionId: string,
    resumed: boolean,
    starts?: "fork" | "summary",
    /** A reply thread's routing turn: a `[[route:…]]` reply is a directive (r.directive), never shown as text. */
    routes = false,
  ): Promise<RunResult> {
    return new Promise((resolve) => {
      const login = host.login?.() ?? null
      const launch = this.launch(host, sessionArgs, sessionId, resumed, login)
      const cliName = launch.cli === "codex" ? `codex (${this.c.codexBin})` : `claude (${this.c.claudeBin})`

      let child: ChildProcess
      try {
        child = spawn(launch.bin, launch.args, { cwd: host.cwd, env: launch.env, stdio: ["pipe", "pipe", "pipe"] })
      } catch (err) {
        resolve({ ok: false, error: `Couldn't start ${launch.cli}: ${(err as Error).message}`, noSession: true })
        return
      }
      r.child = child
      let buf = ""
      let stderr = ""
      let settled = false
      let sawInit = false
      let sawResult = false
      let resultError: string | null = null
      let resultUsage: ReturnType<typeof resultUsageObject> = null
      let resultSessionUsage: ReturnType<typeof sessionUsageOf> = null
      let resultCostUsd: number | null = null
      let resultDurationMs: number | null = null
      let resultModel: string | null = null
      const startedAt = Date.now()
      const timer = setTimeout(() => child.kill("SIGTERM"), TURN_TIMEOUT_MS)
      const alive = () => !this.stopped && this.runs.get(id) === r

      let seenSession: string | null = null
      // A routing turn holds its live text back while it may still be a directive.
      let held: string | null = routes ? "" : null
      const onLine = (line: string) => {
        if (launch.translate) {
          for (const m of launch.translate(line)) onMsg(m)
          return
        }
        let msg: any
        try {
          msg = JSON.parse(line)
        } catch {
          return
        }
        onMsg(msg)
      }
      const onMsg = (msg: any) => {
        if (!alive()) return
        if (typeof msg.session_id === "string") seenSession = msg.session_id
        if (msg.type === "rate_limit_event") return void recordLimits(this.store, this.hub, launch.login, limitsOf(msg), typeof msg.at === "number" ? msg.at : Date.now())
        if (msg.type === "stream_event") {
          const ev = msg.event
          if (ev?.type !== "content_block_delta" || ev.delta?.type !== "text_delta") return
          if (held !== null) {
            held += ev.delta.text
            if (mayBeDirective(held)) return
            this.hub.broadcast({ type: "thread.delta", threadId: id, text: held })
            held = null
            return
          }
          this.hub.broadcast({ type: "thread.delta", threadId: id, text: ev.delta.text })
          return
        }
        if (msg.type === "system" && msg.subtype === "init") {
          sawInit = true
          // Codex names its own thread: that's the session the thread's next question resumes.
          if (starts) this.store.startSideThread(id, starts, launch.cli === "codex" ? (seenSession ?? sessionId) : sessionId)
          return
        }
        if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
          let text = parseNextSteps(
            msg.message.content
              .filter((b: any) => b.type === "text")
              .map((b: any) => b.text)
              .join("")
              .trim(),
          ).content.trim()
          if (routes) {
            // The next message's live text is held back again, until it can't be a directive.
            held = ""
            const d = parseRouteDirective(text)
            if (d.route) {
              r.directive ??= d.route
              text = d.rest
            }
          }
          if (text) {
            const m = this.store.addSideThreadMessage(id, "assistant", text)
            this.hub.broadcast({ type: "thread.message", message: m })
            // Its reply count and unread mark.
            this.publish(id)
          }
          for (const b of msg.message.content) {
            if (b.type !== "tool_use") continue
            const m = this.store.addSideThreadMessage(id, "tool", String(b.name).replace(/^mcp__boxyard__/, ""), { input: b.input })
            this.hub.broadcast({ type: "thread.message", message: m })
          }
          return
        }
        if (msg.type === "result") {
          sawResult = true
          resultUsage = resultUsageObject(msg.usage)
          resultSessionUsage = sessionUsageOf(msg.modelUsage)
          resultCostUsd = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : null
          resultDurationMs = typeof msg.duration_ms === "number" ? msg.duration_ms : null
          resultModel = typeof msg.model === "string" ? msg.model : null
          if (msg.is_error) resultError = String(msg.result ?? msg.subtype ?? "error")
        }
      }

      child.stdout!.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8")
        const lines = buf.split("\n")
        buf = lines.pop() ?? ""
        for (const line of lines) if (line.trim()) onLine(line)
      })
      child.stderr!.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-6000)
      })
      const finish = (code: number | null, err?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (buf.trim()) onLine(buf)
        r.child = null
        launch.after()
        const noSession = !sawInit
        if (!alive()) return resolve({ ok: false, error: "Stopped.", noSession })
        if (resultUsage || resultSessionUsage || typeof resultCostUsd === "number" || typeof resultDurationMs === "number") {
          this.store.recordClaudeUsage({
            source: host.usage.source,
            runKind: "thread",
            projectId: host.usage.projectId,
            sessionId: seenSession ?? sessionId,
            model: resultModel ?? host.model() ?? "codex",
            startedAt,
            endedAt: Date.now(),
            durationMs: resultDurationMs,
            usage: resultUsage,
            sessionUsage: resultSessionUsage,
            costUsd: resultCostUsd,
            resumed,
            loginId: login?.id ?? null,
            harness: launch.cli,
          })
        }
        // A thread doesn't hold its chat's login; it tells the rotation how the login did.
        if (login && this.logins) {
          if (!err && code === 0 && !resultError && (sawResult || launch.cli === "claude")) this.logins.reportSuccess(login.id)
          else if (!err) this.logins.reportFailure(login.id, login.harness, resultError ?? (launch.cli === "codex" ? codexErrorText(stderr) : stderr))
        }
        if (err) return resolve({ ok: false, error: `Couldn't run ${cliName}: ${err.message}`, noSession })
        if (code === 0 && !resultError && (sawResult || launch.cli === "claude")) return resolve({ ok: true, error: "", noSession })
        resolve({ ok: false, error: resultError ?? ((launch.cli === "codex" ? codexErrorText(stderr) : stderr.trim()) || `${launch.cli} exited with code ${code}${sawResult ? "" : " before answering"}`), noSession })
      }
      child.on("error", (err) => finish(null, err))
      child.on("close", (code) => finish(code))
      child.stdin!.on("error", () => {})
      child.stdin!.end(prompt)
    })
  }
}
