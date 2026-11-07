import { randomBytes } from "node:crypto"
import type { Response } from "express"
import type { StreamHello, StreamPosition } from "../shared/boot.js"
import type { Task, UiEvent } from "../shared/types.js"

/** Tasks whose last-sent fields the hub keeps to diff against (most recently updated first); an older one goes whole. */
const TRACKED_TASKS = 1000

interface Client {
  res: Response
  /** Opened with `?patches=1`: a task this connection was sent whole comes as `task.patch` afterwards (shared/taskPatch.ts). */
  patches: boolean
  /** The tasks this connection has been sent whole. */
  seen: Set<string>
}

/**
 * Fans server events out to every open browser tab over SSE. Events are counted: a stream opens with a "hello" saying
 * how many this server has sent, and a snapshot (GET /api/boot) marks its place in every open stream, so the web app
 * knows which of the events it hears the snapshot already includes.
 */
export class Hub {
  private clients = new Set<Client>()
  /** Each task's fields as last sent (see kept()), to diff its next update against. */
  private sent = new Map<string, Map<string, unknown>>()
  private heartbeat: NodeJS.Timeout
  /** This server's run: a restart starts counting again. */
  private readonly epoch = randomBytes(6).toString("hex")
  private seq = 0
  /** The web build the server serves now (server/webApp.ts webBuild): each stream's "hello" says it. */
  private web: () => string | null = () => null

  constructor() {
    this.heartbeat = setInterval(() => {
      for (const c of this.clients) c.res.write(": ping\n\n")
    }, 25_000)
    this.heartbeat.unref()
  }

  attach(res: Response, opts: { patches?: boolean } = {}) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    })
    res.write("retry: 2000\n\n")
    res.write(`event: hello\ndata: ${JSON.stringify(this.hello())}\n\n`)
    const client: Client = { res, patches: Boolean(opts.patches), seen: new Set() }
    this.clients.add(client)
    res.on("close", () => this.clients.delete(client))
  }

  /** Serve `build` in each stream's "hello": a tab whose page loaded another build reloads (web/src/lib/appUpdate.ts). */
  setWebBuild(build: () => string | null) {
    this.web = build
  }

  /** A new stream's first event: where it starts, and the web build a reload would load now. */
  hello(): StreamHello {
    return { ...this.position(), web: this.web() }
  }

  /** Where the stream is now: a snapshot read with it includes every event sent so far, and none after. */
  position(): StreamPosition {
    return { epoch: this.epoch, seq: this.seq }
  }

  /**
   * The position, also written into every open stream as a "boot" event: a stream opened before a snapshot read now
   * hears, among its events, exactly where the snapshot falls (counting can't say: a patch client hears nothing of an
   * update that changed nothing).
   */
  mark(): StreamPosition {
    const at = this.position()
    const data = `event: boot\ndata: ${JSON.stringify(at)}\n\n`
    for (const c of this.clients) this.write(c, data)
    return at
  }

  broadcast(event: UiEvent) {
    this.seq++
    if (event.type === "task") return this.broadcastTask(event.task)
    if (event.type === "task.deleted") this.sent.delete(event.taskId)
    const data = `data: ${JSON.stringify(event)}\n\n`
    for (const c of this.clients) this.write(c, data)
  }

  /**
   * A task update carries the whole task (the prompt, summary and placement included) and a busy agent sends one
   * after every assistant message, mostly to move its context meter. A patch client gets the task whole once per
   * connection, then only the fields that changed, and nothing when none did; the rest get it whole every time.
   */
  private broadcastTask(task: Task) {
    const fields = new Map<string, unknown>()
    for (const key in task) {
      const value = task[key as keyof Task]
      if (value !== undefined) fields.set(key, kept(value))
    }
    const prev = this.sent.get(task.id)
    this.sent.delete(task.id)
    this.sent.set(task.id, fields)
    if (this.sent.size > TRACKED_TASKS) this.sent.delete(this.sent.keys().next().value!)
    let whole: string | undefined
    let patch: string | null | undefined
    for (const c of this.clients) {
      if (c.patches && prev && c.seen.has(task.id)) {
        if (patch === undefined) patch = patchFrame(task.id, prev, fields)
        if (patch) this.write(c, patch)
      } else {
        whole ??= `data: ${JSON.stringify({ type: "task", task })}\n\n`
        this.write(c, whole)
        if (c.patches) c.seen.add(task.id)
      }
    }
  }

  private write(c: Client, data: string) {
    try {
      c.res.write(data)
    } catch {
      this.clients.delete(c)
    }
  }

  close() {
    clearInterval(this.heartbeat)
    for (const c of this.clients) c.res.end()
    this.clients.clear()
    this.sent.clear()
  }
}

/** A field as the hub keeps it to compare: a primitive as is, an object (a fresh copy every update) as its JSON. */
type Kept = { json: string }
const kept = (value: unknown) => (value !== null && typeof value === "object" ? { json: JSON.stringify(value) } : value)
const isKept = (v: unknown): v is Kept => v !== null && typeof v === "object"
const same = (a: unknown, b: unknown) => a === b || (isKept(a) && isKept(b) && a.json === b.json)

/** The `task.patch` frame from `prev` to `next`, or null when nothing changed. */
function patchFrame(id: string, prev: Map<string, unknown>, next: Map<string, unknown>): string | null {
  const changed: string[] = []
  for (const [key, value] of next) if (!same(prev.get(key), value)) changed.push(`${JSON.stringify(key)}:${isKept(value) ? value.json : JSON.stringify(value)}`)
  const unset = [...prev.keys()].filter((key) => !next.has(key))
  if (!changed.length && !unset.length) return null
  return `data: {"type":"task.patch","id":${JSON.stringify(id)},"patch":{${changed.join(",")}}${unset.length ? `,"unset":${JSON.stringify(unset)}` : ""}}\n\n`
}
