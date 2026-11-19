import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type { Boxd } from "@boxd-sh/sdk"
import type { Config } from "../config.js"
import type { WorkerSize } from "../../shared/types.js"
import { errorMessage, retry } from "../util/retry.js"
import type { CredentialStore } from "../credentials.js"
import { q, type BoxHealth, type BoxProvider, type BoxSnapshotInfo, type BoxUsageProbe, type ExecResult } from "./types.js"
import { BOX_GIT_CREDENTIAL_SCRIPT } from "./upstash.js"
import { claudeCliFloorScript } from "../../shared/claudeCli.js"

/**
 * Worker boxes that are boxd machines (https://boxd.sh, docs/boxd.md): persistent hardware-isolated Linux
 * VMs with node, git, Claude Code and codex already installed. Every machine is made isolated (no metadata
 * endpoint, no in-VM boxd CLI, no place on the org network), so a box never holds anything that could reach
 * the boxd account its siblings live on. Box ids carry the `boxd-` prefix on the machine id (like
 * LocalProvider's local-), so providers/auto.ts routes each box to the provider that made it by id alone,
 * whatever keys are set now. The SDK loads lazily, on the first call that needs a client: a Box Yard that
 * never uses boxd never loads its gRPC stack.
 */

const ROOT = "/home/boxd/yard"
const NAME_PREFIX = "byard-"
/** boxd snapshots are addressed by name org-wide: the snapshot "id" this provider hands out is `boxd-<name>`. */
const SNAPSHOT_WAIT_MS = 10 * 60_000

/** The boxd API this provider uses: the SDK's own class, as a type only so importing this module loads nothing. */
export type BoxdClient = Pick<Boxd, "machines" | "snapshots" | "close">

export const BOXD_BOX_PREFIX = "boxd-"
/** A boxd box id: `boxd-<machine id>`, like LocalProvider's `local-<id>` folder ids. */
export const isBoxdBox = (id: string) => id.startsWith(BOXD_BOX_PREFIX)
/** The machine id (or snapshot name) inside a boxd id; a bare one passes through, for callers that hold machine ids. */
export const boxdMachineId = (id: string) => (isBoxdBox(id) ? id.slice(BOXD_BOX_PREFIX.length) : id)

/**
 * The string labels a box carries at Upstash ("boxyard", "by-<install>", "p-<project>" — tasks.ts boxLabels)
 * become boxd's key=value labels: the part before the first dash is the key, the whole label the value
 * ("by-a1b2" → { by: "by-a1b2" }). listIds(label) asks for the same pair, so the leftover sweep only ever
 * sees machines that carry this install's label — never another Box Yard's on the same account.
 */
export function boxdLabelPairs(labels: string[]): Record<string, string> {
  const pairs: Record<string, string> = {}
  for (const label of labels) {
    const key = (label.split("-")[0] ?? "").replace(/[^a-z0-9._/-]/g, "")
    // Keys are 1-63 chars of a-z 0-9 . _ / - and must start and end with a letter or digit; values max 256, no control chars.
    if (/^[a-z0-9](?:[a-z0-9._/-]{0,61}[a-z0-9])?$/.test(key)) pairs[key] = label.slice(0, 256).replace(/[^\x20-\x7e]/g, "")
  }
  return pairs
}

/**
 * Box Yard's worker sizes onto boxd's size classes: 1 vCPU/4 GiB, 2 vCPU/8 GiB, 4 vCPU/16 GiB, every machine
 * a 100 GB disk. Not BOX_SIZE_SPECS: those are Upstash's sizes (a small box there is 2 vCPU); this is this
 * provider's own translation of the same three worker sizes.
 */
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
  private client: { key: string; boxd: BoxdClient } | null = null
  private connecting: { key: string; client: Promise<BoxdClient> } | null = null

  /**
   * `creds` reads the boxd API key on each use (Settings › Credentials, env wins); without it, the env value
   * at startup. `makeClient` stands in for the SDK in tests; the default loads @boxd-sh/sdk lazily.
   */
  constructor(
    private readonly c: Config,
    private readonly creds?: Pick<CredentialStore, "get">,
    private readonly makeClient: (apiKey: string) => Promise<BoxdClient> = async (apiKey) =>
      new (await import("@boxd-sh/sdk")).Boxd({ apiKey }),
  ) {}

  private get apiKey() {
    return this.creds ? this.creds.get("boxdApiKey") : this.c.boxdApiKey
  }

  /** The client for the key in effect, made once per key; concurrent callers share one connect, a failed one is retried. */
  private async api(): Promise<BoxdClient> {
    const key = this.apiKey
    if (this.client?.key === key) return this.client.boxd
    if (this.connecting?.key !== key) {
      const old = this.client
      this.client = null
      const client = this.makeClient(key)
      this.connecting = { key, client }
      void old?.boxd.close().catch(() => {})
      // A failed connect isn't kept: the next call that needs this key tries again.
      client.catch(() => {
        if (this.connecting?.client === client) this.connecting = null
      })
    }
    const boxd = await this.connecting!.client
    // The key may have changed while connecting: never clobber the newer client with this one.
    if (this.apiKey === key && this.client?.key !== key) this.client = { key, boxd }
    return this.client?.key === key ? this.client.boxd : boxd
  }

  root() {
    return ROOT
  }

  snapshotDirs() {
    // boxd machines ship tools in ~/.local/bin, which the shell() PATH export below puts on PATH.
    return { home: "/home/boxd", tmp: "/tmp" }
  }

  async create(opts: { labels: string[]; size?: WorkerSize; snapshotId?: string }): Promise<string> {
    // Names are unique across all of boxd, so ours are generated; a collision is a retried create.
    const name = `${NAME_PREFIX}${randomUUID().slice(0, 8)}`
    const boxd = await this.api()
    const labels = boxdLabelPairs(opts.labels)
    // A machine from a snapshot resumes as captured (its size, env and image are the snapshot's), with the
    // labels merged over the ones it carries; a cold machine gets the yard's size and the usual sandbox env.
    // Both are isolated, and a restore re-isolates even a snapshot that wasn't.
    const machine = opts.snapshotId
      ? await boxd.machines.create({ name, fromSnapshot: boxdMachineId(opts.snapshotId), isolated: true, labels })
      : await boxd.machines.create({
          name,
          isolated: true,
          labels,
          env: { DISABLE_AUTOUPDATER: "1", IS_SANDBOX: "1" },
          config: SIZES[opts.size ?? this.c.workerSize] ?? SIZES.medium,
        })
    const boxId = `${BOXD_BOX_PREFIX}${machine.id}`
    try {
      await boxd.machines.waitUntilReady(machine.id)
      const setup = await this.exec(boxId, boxdWorkerSetupScript())
      if (setup.exitCode !== 0) throw new Error(`worker setup failed: ${(setup.stderr || setup.stdout).slice(-1500)}`)
    } catch (err) {
      await this.destroy(boxId).catch(() => {})
      throw err
    }
    return boxId
  }

  private async machine(boxId: string) {
    const id = boxdMachineId(boxId)
    return retry(() => this.api().then((boxd) => boxd.machines.get(id)))
  }

  async health(boxId: string): Promise<BoxHealth> {
    try {
      const m = await this.machine(boxId)
      if (m.status === "destroyed") return "gone"
      if (m.status === "failed") return "error"
      if (m.status === "migrating") return "unknown"
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
    const id = boxdMachineId(boxId)
    if (health === "paused") await retry(() => this.api().then((boxd) => boxd.machines.wake(id)))
  }

  /**
   * `bash -c` with the machine's preinstalled tools (~/.local/bin) on PATH, like Upstash's plain shells: no
   * profile runs, so no stray output lands in what Box Yard parses.
   */
  private shell(command: string): string[] {
    return ["bash", "-c", `PATH="$HOME/.local/bin:$PATH"; ${command}`]
  }

  async exec(boxId: string, command: string): Promise<ExecResult> {
    const id = boxdMachineId(boxId)
    const argv = this.shell(command)
    const r = await retry(() => this.api().then((boxd) => boxd.machines.exec(id, { command: argv })))
    return { exitCode: r.exitCode ?? (r.success ? 0 : 1), stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
  }

  async execStream(boxId: string, command: string, onOutput: (chunk: string) => void): Promise<{ exitCode: number }> {
    const boxd = await this.api()
    const stream = boxd.machines.streamExec(boxdMachineId(boxId), { command: this.shell(command) })
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
      const boxd = await this.api()
      const stream = boxd.machines.streamExec(boxdMachineId(boxId), { command: this.shell(command) })
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
    const id = boxdMachineId(boxId)
    await retry(() => this.exec(boxId, `mkdir -p ${q(path.posix.dirname(filePath))}`))
    const data = Buffer.isBuffer(content) ? new Uint8Array(content) : content
    await retry(() => this.api().then((boxd) => boxd.machines.files.upload(id, filePath, data)))
  }

  async readFile(boxId: string, filePath: string): Promise<Buffer> {
    const id = boxdMachineId(boxId)
    const bytes = await retry(() => this.api().then((boxd) => boxd.machines.files.download(id, filePath)))
    return Buffer.from(bytes)
  }

  async uploadFile(boxId: string, localPath: string, destination: string) {
    if (!fs.existsSync(localPath)) throw new Error(`upload: ${localPath} does not exist`)
    const id = boxdMachineId(boxId)
    await retry(() => this.exec(boxId, `mkdir -p ${q(path.posix.dirname(destination))}`))
    await retry(() => this.api().then((boxd) => boxd.machines.files.upload(id, destination, { fromPath: localPath })))
  }

  async publicUrl(boxId: string, port: number): Promise<string> {
    const id = boxdMachineId(boxId)
    const boxd = await this.api()
    // A preview URL must be a subdomain proxy: the machine's main address answers non-browser clients (Box
    // Yard's own checks, uptime probes) with a bot-protection challenge page, and subdomain proxies are never
    // checked (docs.boxd.sh/guides/bot-protection.md). A port can be asked for twice (re-shared, or a turn
    // after a restart): reuse its proxy instead of making a second one.
    const sub = (routes: { domain: string; port: number; isDefault?: boolean }[]) => {
      const domain = routes.find((r) => r.port === port && !r.isDefault)?.domain
      return domain ? (domain.startsWith("http") ? domain : `https://${domain}`) : null
    }
    const existing = sub(await retry(() => boxd.machines.proxies.list(id)))
    if (existing) return existing
    // The proxy's name is its subdomain label, and a proxy is pinned to its port: p<port>. The subdomain's
    // certificate takes a few seconds to come up; Box Yard only hands the URL out, and the first browser
    // or probe that follows it arrives later.
    await boxd.machines.proxies.create(id, `p${port}`, port)
    const made = sub(await retry(() => boxd.machines.proxies.list(id)))
    if (!made) throw new Error(`boxd made no proxy for port ${port}`)
    return made
  }

  async snapshot(boxId: string, name: string): Promise<BoxSnapshotInfo> {
    // Not retried: a second call would make a second snapshot.
    const boxd = await this.api()
    await boxd.snapshots.create(boxdMachineId(boxId), name)
    return { id: `${BOXD_BOX_PREFIX}${name}`, bytes: await this.snapshotBytes(name) }
  }

  /** Wait for the capture to finish, then read its size; a boxd snapshot of a young disk is quick. */
  private async snapshotBytes(name: string): Promise<number | null> {
    const until = Date.now() + SNAPSHOT_WAIT_MS
    while (Date.now() < until) {
      const snap = await this.api().then((boxd) => boxd.snapshots.get(name)).catch(() => undefined)
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
      await retry(() => this.api().then((boxd) => boxd.snapshots.delete(boxdMachineId(snapshotId))))
    } catch (err) {
      // Already gone (deleted in the console, or by an earlier try): that's what was asked for.
      if (!boxdIsGone(err)) throw err
    }
  }

  /** The machines this Box Yard made, by name prefix: any install of it on the account, labeled or not. */
  private async ours(): Promise<{ id: string; name: string; status: string }[]> {
    const all = await retry(() => this.api().then((boxd) => boxd.machines.list()))
    return all.filter((m) => m.name.startsWith(NAME_PREFIX) && m.status !== "destroyed")
  }

  /** Machines carrying this install's label ("by-…"), as box ids: the leftover sweep's list, and no other install's. */
  async listIds(label: string): Promise<string[]> {
    const pairs = boxdLabelPairs([label])
    if (!Object.keys(pairs).length) return []
    const machines = await retry(() => this.api().then((boxd) => boxd.machines.list({ labels: pairs })))
    return machines.filter((m) => m.status !== "destroyed").map((m) => `${BOXD_BOX_PREFIX}${m.id}`)
  }

  async liveIds(): Promise<string[]> {
    return (await this.ours()).map((m) => `${BOXD_BOX_PREFIX}${m.id}`)
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
    const id = boxdMachineId(boxId)
    await retry(() => this.api().then((boxd) => boxd.machines.resize(id, { vcpu: (SIZES[size] ?? SIZES.medium).vcpu })))
  }

  async destroy(boxId: string) {
    const id = boxdMachineId(boxId)
    try {
      await retry(() => this.api().then((boxd) => boxd.machines.delete(id)))
    } catch (err) {
      // Already gone (deleted in the console, or by an earlier try): that's what was asked for.
      if (!boxdIsGone(err)) throw err
    }
  }
}
