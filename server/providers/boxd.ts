import { Boxd } from "@boxd-sh/sdk"
import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type { Config } from "../config.js"
import type { WorkerSize } from "../../shared/types.js"
import { errorMessage, retry } from "../util/retry.js"
import type { CredentialStore } from "../credentials.js"
import { q, type BoxHealth, type BoxProvider, type BoxSnapshotInfo, type BoxUsageProbe, type ExecResult } from "./types.js"
import { BOX_GIT_CREDENTIAL_SCRIPT } from "./upstash.js"
import { claudeCliFloorScript } from "../../shared/claudeCli.js"

/**
 * Worker boxes that are boxd machines (https://boxd.sh, docs/boxd.md): persistent hardware-isolated Linux
 * VMs with node, git, claude and codex already installed. Machine names start with byard- so listIds can
 * tell ours from the org's other machines; box ids are boxd's machine ids (UUIDs).
 */

const ROOT = "/home/boxd/yard"
const NAME_PREFIX = "byard-"
/** boxd snapshots are addressed by name org-wide: the snapshot "id" this provider hands out is that name. */
const SNAPSHOT_WAIT_MS = 10 * 60_000

/** Box Yard's worker sizes onto boxd's (1 vCPU/4 GiB, 2 vCPU/8 GiB, 4 vCPU/16 GiB). */
const SIZES: Record<WorkerSize, { vcpu: number; memory: string }> = {
  small: { vcpu: 1, memory: "4G" },
  medium: { vcpu: 2, memory: "8G" },
  large: { vcpu: 4, memory: "16G" },
}

/**
 * Make the yard's folders and set up git. boxd machines ship with Claude Code, Codex, node and git, so
 * unlike Upstash there is nothing to install; the floor script only replaces a claude too old for the
 * newest model. No credential is baked into the machine: tokens come with each turn (task.json).
 */
export function boxdWorkerSetupScript() {
  return [
    "set -e",
    `mkdir -p ${ROOT}/.boxyard ${ROOT}/tasks`,
    claudeCliFloorScript(),
    "git config --global init.defaultBranch main",
    BOX_GIT_CREDENTIAL_SCRIPT,
    "claude --version",
  ].join(" && ")
}

/** The boxd API says the machine doesn't exist: 404-ish, or a "not found"/"no such machine" error. */
export function boxdIsGone(err: unknown): boolean {
  const code = (err as { code?: string | number } | null)?.code
  if (code === "NOT_FOUND" || code === 404 || code === 410) return true
  return /not found|no such machine|unknown machine|doesn'?t exist/i.test(errorMessage(err))
}

export class BoxdProvider implements BoxProvider {
  readonly name = "boxd"
  readonly nodeBin = "node"
  readonly claudeBin = "claude"
  readonly codexBin = "codex"
  /** Each boxd machine is its own VM with its own kernel, so its cgroup CPU counter is its own. */
  readonly ownCgroup = true
  /** One client per key: a new key (Settings, env) drops the old connection. */
  private client: { key: string; boxd: Boxd } | null = null

  /** `creds` reads the boxd API key on each use (Settings › Credentials, env wins); without it, the env value at startup. */
  constructor(
    private readonly c: Config,
    private readonly creds?: Pick<CredentialStore, "get">,
  ) {}

  private get apiKey() {
    return this.creds ? this.creds.get("boxdApiKey") : this.c.boxdApiKey
  }

  private api(): Boxd {
    const key = this.apiKey
    if (this.client?.key !== key) {
      this.client?.boxd.close().catch(() => {})
      this.client = { key, boxd: new Boxd({ apiKey: key }) }
    }
    return this.client.boxd
  }

  root() {
    return ROOT
  }

  snapshotDirs() {
    // boxd machines ship tools in ~/.local/bin, which login shells put on PATH.
    return { home: "/home/boxd", tmp: "/tmp" }
  }

  async create(opts: { labels: string[]; size?: WorkerSize; snapshotId?: string }): Promise<string> {
    // Names are unique across all of boxd, so ours are generated; a collision is a retried create.
    const name = `${NAME_PREFIX}${randomUUID().slice(0, 8)}`
    const boxd = this.api()
    // A machine from a snapshot resumes as captured (its size, env and image are the snapshot's), and create
    // refuses env/sizing beside it; a cold machine gets the yard's size and the usual sandbox env.
    const machine = opts.snapshotId
      ? await boxd.machines.create({ name, fromSnapshot: opts.snapshotId })
      : await boxd.machines.create({
          name,
          env: { DISABLE_AUTOUPDATER: "1", IS_SANDBOX: "1" },
          config: SIZES[opts.size ?? this.c.workerSize] ?? SIZES.medium,
        })
    try {
      await boxd.machines.waitUntilReady(machine.id)
      const setup = await this.exec(machine.id, boxdWorkerSetupScript())
      if (setup.exitCode !== 0) throw new Error(`worker setup failed: ${(setup.stderr || setup.stdout).slice(-1500)}`)
    } catch (err) {
      await this.destroy(machine.id).catch(() => {})
      throw err
    }
    return machine.id
  }

  private async machine(boxId: string) {
    return retry(() => this.api().machines.get(boxId))
  }

  async health(boxId: string): Promise<BoxHealth> {
    try {
      const m = await this.machine(boxId)
      if (m.status === "destroyed") return "gone"
      if (m.status === "failed") return "error"
      // Suspended (standby), hibernated (on disk) and stopped all come back with wake.
      if (m.status === "suspended" || m.status === "hibernated" || m.status === "stopped") return "paused"
      return "running"
    } catch (err) {
      if (boxdIsGone(err)) return "gone"
      return "unknown"
    }
  }

  async wake(boxId: string) {
    const health = await this.health(boxId)
    if (health === "paused") await retry(() => this.api().machines.wake(boxId))
  }

  async exec(boxId: string, command: string): Promise<ExecResult> {
    // A login shell, so ~/.local/bin (claude, codex) is on PATH like an SSH session.
    const r = await retry(() => this.api().machines.exec(boxId, { command: ["bash", "-lc", command] }))
    return { exitCode: r.exitCode ?? (r.success ? 0 : 1), stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
  }

  async execStream(boxId: string, command: string, onOutput: (chunk: string) => void): Promise<{ exitCode: number }> {
    const stream = this.api().machines.streamExec(boxId, { command: ["bash", "-lc", command] })
    const decode = (chunk: unknown) => (typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"))
    const pumps = [stream, (stream as { stderr?: AsyncIterable<unknown> }).stderr].filter(
      (s): s is AsyncIterable<unknown> => Boolean(s),
    )
    // Not retried: output may already have been handed over. A caller that fails tries again later.
    await Promise.all(pumps.map(async (iter) => {
      for await (const chunk of iter) onOutput(decode(chunk))
    }))
    const code = await stream.wait()
    return { exitCode: typeof code === "number" ? code : 1 }
  }

  async hold(boxId: string, command: string, signal: AbortSignal): Promise<void> {
    try {
      const stream = this.api().machines.streamExec(boxId, { command: ["bash", "-lc", command] })
      const onAbort = () => stream.close()
      signal.addEventListener("abort", onAbort, { once: true })
      try {
        await stream.wait()
      } finally {
        signal.removeEventListener("abort", onAbort)
      }
    } catch {
      // Dropped connections are expected; the caller re-attaches if needed.
    }
  }

  async writeFile(boxId: string, filePath: string, content: string | Buffer) {
    await retry(() => this.exec(boxId, `mkdir -p ${q(path.posix.dirname(filePath))}`))
    const data = Buffer.isBuffer(content) ? new Uint8Array(content) : content
    await retry(() => this.api().machines.files.upload(boxId, filePath, data))
  }

  async readFile(boxId: string, filePath: string): Promise<Buffer> {
    const bytes = await retry(() => this.api().machines.files.download(boxId, filePath))
    return Buffer.from(bytes)
  }

  async uploadFile(boxId: string, localPath: string, destination: string) {
    if (!fs.existsSync(localPath)) throw new Error(`upload: ${localPath} does not exist`)
    await retry(() => this.exec(boxId, `mkdir -p ${q(path.posix.dirname(destination))}`))
    await retry(() => this.api().machines.files.upload(boxId, destination, { fromPath: localPath }))
  }

  async publicUrl(boxId: string, port: number): Promise<string> {
    const boxd = this.api()
    const label = `p${port}`
    try {
      await boxd.machines.proxies.create(boxId, label, port)
    } catch (err) {
      // Same port twice keeps the first proxy: reuse it below.
      if (!/exist|duplicate|already|conflict/i.test(errorMessage(err))) throw err
    }
    const routes = await retry(() => boxd.machines.proxies.list(boxId))
    const route = routes.find((r) => r.port === port)
    if (!route?.domain) throw new Error(`boxd made no proxy for port ${port}`)
    return route.domain.startsWith("http") ? route.domain : `https://${route.domain}`
  }

  async snapshot(boxId: string, name: string): Promise<BoxSnapshotInfo> {
    // Not retried: a second call would make a second snapshot.
    const boxd = this.api()
    await boxd.snapshots.create(boxId, name)
    return { id: name, bytes: await this.snapshotBytes(name) }
  }

  /** Wait for the capture to finish, then read its size; a boxd snapshot of a young disk is quick. */
  private async snapshotBytes(name: string): Promise<number | null> {
    const until = Date.now() + SNAPSHOT_WAIT_MS
    while (Date.now() < until) {
      const snap = await this.api().snapshots.get(name).catch(() => undefined)
      if (!snap) return null
      if (snap.status === "failed") throw new Error(`boxd snapshot ${name} failed`)
      if (snap.status === "ready") return snap.sizeBytes ?? null
      await new Promise((r) => setTimeout(r, 5_000))
    }
    throw new Error(`boxd snapshot ${name} wasn't ready after ${SNAPSHOT_WAIT_MS / 60_000} minutes`)
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    if (!snapshotId.trim()) throw new Error("deleteSnapshot needs a snapshot id")
    try {
      await this.api().snapshots.delete(snapshotId)
    } catch (err) {
      // Already gone (deleted in the console, or by an earlier try): that's what was asked for.
      if (!boxdIsGone(err)) throw err
    }
  }

  private async ours(): Promise<{ id: string; status: string }[]> {
    // boxd has no box labels on plain machines, so ours are the ones our prefix names; the label arg is ignored.
    const all = await retry(() => this.api().machines.list())
    return all.filter((m) => m.name.startsWith(NAME_PREFIX) && m.status !== "destroyed").map((m) => ({ id: m.id, status: m.status }))
  }

  async listIds(_label: string): Promise<string[]> {
    return (await this.ours()).map((m) => m.id)
  }

  async liveIds(): Promise<string[]> {
    return (await this.ours()).map((m) => m.id)
  }

  private async diskBytes(boxId: string): Promise<number | null> {
    const res = await this.exec(boxId, `du -sk ${q(ROOT)} 2>/dev/null | awk '{print $1}'`)
    if (res.exitCode !== 0) return null
    const kb = Number.parseInt(res.stdout.trim(), 10)
    return Number.isFinite(kb) ? kb * 1024 : null
  }

  /** Best-effort: boxd bills active vCPU only and doesn't expose per-machine compute totals, so Box Yard estimates. */
  async usage(boxId: string): Promise<BoxUsageProbe> {
    const [m, diskBytes] = await Promise.all([this.machine(boxId).catch(() => undefined), this.diskBytes(boxId).catch(() => null)])
    const vcpu = m?.resources?.vcpu
    const size = vcpu === 1 ? "small" : vcpu === 2 ? "medium" : vcpu === 4 || vcpu === 8 ? "large" : this.c.workerSize
    return { size, diskBytes, source: "estimated" }
  }

  /** Change a machine's size in place, keeping its disk; boxd reboots it to apply. */
  async resize(boxId: string, size: WorkerSize): Promise<void> {
    await retry(() => this.api().machines.resize(boxId, { vcpu: (SIZES[size] ?? SIZES.medium).vcpu }))
  }

  async destroy(boxId: string) {
    try {
      await retry(() => this.api().machines.delete(boxId))
    } catch (err) {
      // Already gone (deleted in the console, or by an earlier try): that's what was asked for.
      if (!boxdIsGone(err)) throw err
    }
  }
}
