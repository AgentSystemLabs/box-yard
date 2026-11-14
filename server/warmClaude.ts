// A claude process kept running between a Captain's turns (Settings › Coordinator › Warm Claude process). A cold
// turn spends about 1.5 s starting Claude Code (node, its config, the MCP handshakes) before the model sees the
// prompt; a warm one writes the prompt to a process that already has, as one line of `--input-format stream-json`,
// and the turn ends at its `result` line. The process then waits for the next line.
//
// It only ever stands in for the exact launch the turn would have started (warmKey: binary, flags, env, folder and
// MCP config): anything else (a new login, model, effort, connector, env var or system prompt) starts it again.
// It runs in its own process group, so killing it takes its MCP servers with it; when Box Yard dies without
// killing it, its stdin closes and Claude Code exits on its own.

import { spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"

export interface WarmLaunch {
  bin: string
  /** Its flags without the session ones (--resume, --session-id): the WarmClaude adds them. */
  args: string[]
  env: NodeJS.ProcessEnv
  cwd: string
}

/** Flags that name the session, with their value: not part of what a warm process stands in for. */
const SESSION_FLAGS = new Set(["--resume", "--session-id"])

/** The flags without the session ones. */
export function withoutSession(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (SESSION_FLAGS.has(args[i]!)) i++
    else out.push(args[i]!)
  }
  return out
}

/**
 * What a warm process stands in for: its binary, flags (but the session), env, folder, and `extra` (the MCP config
 * the flags name by path). Two launches with the same key would start the same Claude Code.
 */
export function warmKey(launch: WarmLaunch, extra = ""): string {
  const env = Object.entries(launch.env)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return createHash("sha256")
    .update(JSON.stringify({ bin: launch.bin, args: withoutSession(launch.args), env, cwd: launch.cwd, extra }))
    .digest("hex")
}

/** How one turn in a warm process ended. */
export interface WarmTurnEnd {
  /** It reached its result line: the turn is over and the process waits for the next one. */
  result: boolean
  /** The process ended instead (code, or the spawn error). */
  code: number | null
  error?: Error
  /** It printed anything for this turn: a turn that died before that can run again cold. */
  output: boolean
}

interface WarmTurn {
  line: (line: string) => void
  output: boolean
  done: (end: WarmTurnEnd) => void
}

export class WarmClaude {
  readonly startedAt = Date.now()
  /** Turns it has taken. */
  turns = 0
  /** When its last turn ended (or it started). */
  usedAt = Date.now()
  private readonly child: ChildProcess
  private buf = ""
  private stderrTail = ""
  private turn: WarmTurn | null = null
  private ended: { code: number | null; error?: Error } | null = null
  private closing = false
  private graceMs = 3000
  private readonly exitWaiters = new Set<() => void>()

  constructor(
    launch: WarmLaunch,
    /** warmKey of the launch it stands in for. */
    readonly key: string,
    /** The session it continues: its turns resume this one. */
    readonly sessionId: string,
    /** Started with --resume (the session already had turns), else --session-id. */
    readonly resumed: boolean,
  ) {
    const args = [...withoutSession(launch.args), "--input-format", "stream-json", ...(resumed ? ["--resume", sessionId] : ["--session-id", sessionId])]
    // Its own process group (not on Windows), so kill() reaches its MCP servers too.
    this.child = spawn(launch.bin, args, { cwd: launch.cwd, env: launch.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" })
    this.child.stdout!.on("data", (chunk: Buffer) => this.onStdout(chunk.toString("utf8")))
    this.child.stderr!.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-6000)
    })
    this.child.stdin!.on("error", () => {})
    this.child.on("error", (error) => this.onEnd({ code: null, error }))
    this.child.on("close", (code) => this.onEnd({ code }))
  }

  get pid(): number | undefined {
    return this.child.pid
  }

  /** It can take a turn now, or after the one it's running. */
  get alive(): boolean {
    return !this.ended && !this.closing && !!this.child.pid
  }

  get busy(): boolean {
    return this.turn !== null
  }

  /** Its stderr so far (the last 6000 characters), for a turn's error. */
  get stderr(): string {
    return this.stderrTail
  }

  /**
   * One turn: the prompt as a stream-json user line. `line` gets each line it prints for the turn, its result line
   * last; then the promise resolves, or when the process ends first.
   */
  run(prompt: string, line: (line: string) => void): Promise<WarmTurnEnd> {
    if (!this.alive || this.turn) return Promise.resolve({ result: false, code: this.ended?.code ?? null, error: new Error("the warm Claude process isn't ready"), output: false })
    return new Promise((done) => {
      this.turn = { line, output: false, done }
      this.turns++
      this.stderrTail = ""
      try {
        this.child.stdin!.write(`${JSON.stringify({ type: "user", message: { role: "user", content: prompt } })}\n`)
      } catch (error) {
        this.endTurn({ result: false, code: null, error: error as Error })
      }
    })
  }

  /**
   * Done with it: Claude Code exits when its stdin closes; the process group goes after `graceMs` if it hasn't. A turn
   * it's running finishes first.
   */
  close(graceMs = 3000) {
    if (this.ended || this.closing) return
    this.closing = true
    this.graceMs = graceMs
    if (!this.turn) this.endInput()
  }

  private endInput() {
    try {
      this.child.stdin!.end()
    } catch {}
    const timer = setTimeout(() => this.kill(), this.graceMs)
    timer.unref?.()
    this.exitWaiters.add(() => clearTimeout(timer))
  }

  /** Ends it and its MCP servers now (a Stop, a timeout, Box Yard shutting down). */
  kill(signal: NodeJS.Signals = "SIGTERM") {
    if (this.ended) return
    this.closing = true
    const pid = this.child.pid
    try {
      if (pid && process.platform !== "win32") process.kill(-pid, signal)
      else this.child.kill(signal)
    } catch {
      try {
        this.child.kill(signal)
      } catch {}
    }
  }

  /** Resolves once the process has ended. */
  exited(): Promise<void> {
    if (this.ended) return Promise.resolve()
    return new Promise((resolve) => this.exitWaiters.add(resolve))
  }

  private onStdout(text: string) {
    this.buf += text
    const lines = this.buf.split("\n")
    this.buf = lines.pop() ?? ""
    for (const l of lines) if (l.trim()) this.onLine(l)
  }

  private onLine(l: string) {
    const turn = this.turn
    // Nothing is asked of it between turns; a line then is noise.
    if (!turn) return
    turn.output = true
    turn.line(l)
    if (l.includes('"result"') && isResult(l)) {
      this.usedAt = Date.now()
      this.endTurn({ result: true, code: 0 })
    }
  }

  private endTurn(end: Omit<WarmTurnEnd, "output">) {
    const turn = this.turn
    if (!turn) return
    this.turn = null
    turn.done({ ...end, output: turn.output })
    // close() came during the turn.
    if (this.closing && !this.ended) this.endInput()
  }

  private onEnd(end: { code: number | null; error?: Error }) {
    if (this.ended) return
    if (this.buf.trim()) this.onLine(this.buf)
    this.buf = ""
    this.ended = end
    this.endTurn({ result: false, ...end })
    for (const w of [...this.exitWaiters]) w()
    this.exitWaiters.clear()
  }
}

function isResult(line: string): boolean {
  try {
    return (JSON.parse(line) as { type?: unknown }).type === "result"
  } catch {
    return false
  }
}
