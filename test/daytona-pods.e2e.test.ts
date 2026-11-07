import { daytonaSize } from "../shared/runnerSizes.js"
import { afterEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { buildMcpServer, type McpCaller } from "../server/mcp.js"
import { LocalProvider } from "../server/providers/local.js"
import type { BoxHealth } from "../server/providers/types.js"
import type { GpuPod, GpuRunner, GpuRunnerSettings } from "../server/tasks.js"
import { Uploads, uploadsDir } from "../server/uploads.js"
import { GPU_BOX_PREFIXES, gpuBoxIdOn, type GpuProvider } from "../shared/gpu.js"
import { DEFAULT_RUNPOD_SETTINGS } from "../shared/runpod.js"
import { DEFAULT_VAST_SETTINGS } from "../shared/vast.js"
import { DEFAULT_DAYTONA_SETTINGS, daytonaMachine, type DaytonaStatus } from "../shared/daytona.js"
import type { Project, Task } from "../shared/types.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// Daytona as the third cloud behind "Runs on: GPU" (docs/daytona.md): a project's sandboxes are daytona-<projectId>[-<n>]
// boxes, and unlike RunPod's and Vast.ai's they count toward Settings › Usage › Daily cloud limit. Every cloud is a
// fake (a "sandbox" is a folder on this machine); the real Daytona client gets a fetch that fails every call.

/** A GPU cloud stand-in: `wake` starts a pod (a folder) at `price`, `destroy` ends it. */
class FakeCloud extends LocalProvider {
  pods = new Map<string, GpuPod>()
  started: string[] = []
  terminated: string[] = []
  onEvent: ((e: { boxId: string; kind: "started" | "terminated"; detail: string }) => void) | null = null
  /** The GPU a typed task asked a new pod for (TaskManager.podGpuTypes), as the real providers read it. */
  podGpu: ((boxId: string) => string[] | null) | null = null
  podSize: ((boxId: string) => string | null) | null = null
  pricedSizes: (string | undefined)[] = []
  private n = 0

  constructor(
    dir: string,
    readonly cloud: GpuProvider,
    public price: number,
    private readonly settings: () => GpuRunnerSettings,
  ) {
    super(dir, FAKE_CLAUDE)
  }

  override async wake(boxId: string) {
    expect(boxId.startsWith(GPU_BOX_PREFIXES[this.cloud])).toBe(true)
    if (this.pods.has(boxId)) return
    this.started.push(boxId)
    const gpu = this.podGpu?.(boxId)?.[0] ?? "RTX 4090"
    const size = daytonaSize(this.podSize?.(boxId) ?? "")
    this.pods.set(boxId, { ...(size ? { vcpus: size.vcpus, memoryGb: size.memoryGb, diskGb: size.diskGb } : {}), id: `${this.cloud}${++this.n}`, status: "RUNNING", cost: this.price, gpu: { id: gpu }, startedAt: new Date().toISOString() })
    fs.mkdirSync(path.join(this.root(boxId), "tasks"), { recursive: true })
    this.onEvent?.({ boxId, kind: "started", detail: `RTX 4090 at $${this.price}/hr` })
  }

  override async health(boxId: string): Promise<BoxHealth> {
    return this.pods.has(boxId) ? "running" : "paused"
  }

  override async destroy(boxId: string) {
    if (!this.pods.delete(boxId)) return
    this.terminated.push(boxId)
    await super.destroy(boxId)
  }

  async listPods() {
    return [...this.pods].map(([boxId, pod]) => ({ boxId, pod }))
  }

  cached(boxId: string) {
    return this.pods.get(boxId) ?? null
  }

  capOf() {
    return this.settings().maxHourlyUsd
  }

  async nextPodPrice(_projectId: string, _gpuTypes?: string[], size?: string) {
    this.pricedSizes.push(size)
    return { gpu: "RTX 4090", usd: this.price }
  }
}

interface Running {
  yard: BoxYard
  server: Server
  base: string
  dataDir: string
  runpod: FakeCloud
  daytona: FakeCloud
  vastSettings: GpuRunnerSettings
  daytonaSettings: GpuRunnerSettings
  /** Every call the real Daytona client made (it should make none: no key). */
  daytonaCalls: string[]
}
const running: Running[] = []
const clients: { close(): Promise<void> }[] = []

async function start(): Promise<Running> {
  const port = await freePort()
  const config = testConfig({ port })
  const runpodSettings = { ...DEFAULT_RUNPOD_SETTINGS }
  const vastSettings: GpuRunnerSettings = { ...DEFAULT_VAST_SETTINGS }
  const daytonaSettings: GpuRunnerSettings = { ...DEFAULT_DAYTONA_SETTINGS, ...daytonaMachine(DEFAULT_DAYTONA_SETTINGS) }
  const runpod = new FakeCloud(tmpDir("runpod-"), "runpod", 0.27, () => runpodSettings)
  const vast = new FakeCloud(tmpDir("vast-"), "vast", 0.2, () => vastSettings)
  const daytona = new FakeCloud(tmpDir("daytona-"), "daytona", 1, () => daytonaSettings)
  const gpu: GpuRunner = { provider: runpod, settings: () => runpodSettings, enabled: () => true, keepWarmUntil: () => null }
  const vastRunner: GpuRunner = { kind: "vast", provider: vast, settings: () => vastSettings, enabled: () => true, keepWarmUntil: () => null }
  const daytonaRunner: GpuRunner = { kind: "daytona", metered: true, provider: daytona, settings: () => daytonaSettings, enabled: () => true, keepWarmUntil: () => null }
  const daytonaCalls: string[] = []
  const daytonaFetch = (async (url: string | URL, init?: RequestInit) => {
    daytonaCalls.push(`${init?.method ?? "GET"} ${url}`)
    throw new Error("No real Daytona in tests")
  }) as typeof fetch
  const yard = createBoxYard(config, { webDir: "/nonexistent", gpu, vast: vastRunner, daytona: daytonaRunner, daytonaFetch })
  for (const c of [runpod, vast, daytona]) {
    c.onEvent = (e) => yard.tasks.gpuPodEvent(e)
    c.podGpu = (boxId) => yard.tasks.podGpuTypes(boxId)
    c.podSize = (boxId) => yard.tasks.podSize(boxId)
  }
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, base: `http://127.0.0.1:${port}`, dataDir: config.dataDir, runpod, daytona, vastSettings, daytonaSettings, daytonaCalls }
  running.push(r)
  return r
}

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  for (const r of running.splice(0)) {
    for (const t of r.yard.store.listTasks()) if (t.status === "working" || t.status === "starting") await r.yard.tasks.stopTask(t.id).catch(() => {})
    await waitFor(() => r.yard.store.listTaskRows().every((t) => !t.current_turn_id), "turns to stop").catch(() => {})
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function call<T>(r: Running, method: string, urlPath: string, body?: unknown): Promise<T> {
  const res = await fetch(r.base + urlPath, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`${method} ${urlPath} -> ${res.status}: ${JSON.stringify(data)}`)
  return data as T
}

const gpuProject = (r: Running, name: string, settings: Partial<Pick<Project, "agentsPerBox" | "maxBoxes" | "gpuProvider">> = {}) =>
  call<Project>(r, "POST", "/api/projects", { name, runner: "gpu", ...settings })
const getTask = (r: Running, id: string) => call<Task>(r, "GET", `/api/tasks/${id}`)
const until = (r: Running, id: string, ok: (t: Task) => boolean, what: string) =>
  waitFor(async () => {
    const t = await getTask(r, id)
    return ok(t) ? t : null
  }, `task ${id} ${what}`)
const working = (r: Running, id: string) => until(r, id, (t) => t.status === "working", "to be working")
const hang = async (r: Running, projectId: string, title: string) => (await call<Task>(r, "POST", "/api/tasks", { projectId, title, prompt: "keep going [hang]" })).id
const boxOf = (r: Running, id: string) => r.yard.store.getTaskRow(id)?.box_id
const sweep = (r: Running, now: number) => (r.yard.tasks as unknown as { sweepGpuPods(now: number): Promise<void> }).sweepGpuPods(now)

type ToolRes = { content: { text: string }[]; isError?: boolean }
async function mcpAs(r: Running, caller: McpCaller) {
  const y = r.yard
  const deps = { store: y.store, tasks: y.tasks, hub: y.hub, artifacts: null as never, publicUrl: () => "", scheduler: y.scheduler, captains: y.captains, settings: y.settings, notes: y.notes, uploads: new Uploads(uploadsDir(r.dataDir), 1024 * 1024) }
  const mcp = buildMcpServer(deps, caller)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await mcp.connect(a)
  const client = new Client({ name: "test", version: "0" })
  await client.connect(b)
  clients.push({ close: async () => (await client.close(), await mcp.close()) })
  return async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as ToolRes
    const text = res.content[0]!.text
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
}

describe("Daytona: a third cloud behind Runs on: GPU", () => {
  it("runs a project on daytona-<projectId> sandboxes, by its own pick or Settings' Default GPU cloud", async () => {
    const r = await start()
    const own = await gpuProject(r, "own", { gpuProvider: "daytona", agentsPerBox: 1 })
    const t1 = await hang(r, own.id, "picked daytona")
    await working(r, t1)
    expect(boxOf(r, t1)).toBe(gpuBoxIdOn("daytona", own.id))

    r.yard.settings.update({ gpuProvider: "daytona" })
    const global = await gpuProject(r, "global", { agentsPerBox: 1 })
    const t2 = await hang(r, global.id, "global daytona")
    await working(r, t2)
    expect(boxOf(r, t2)).toBe(gpuBoxIdOn("daytona", global.id))
    expect(r.daytona.started).toHaveLength(2)
    expect(r.runpod.started).toEqual([])
    const made = r.yard.tasks.history.list({}).find((e) => e.boxId === gpuBoxIdOn("daytona", own.id) && e.type === "created")
    expect(made).toMatchObject({ actor: "scheduler", reason: "A task of a Daytona GPU project needed its pod." })
  })

  it("keeps named Daytona sizes separate from smaller sandboxes and passes the size into pricing and creation", async () => {
    const r = await start()
    const p = await gpuProject(r, "cpu-sizes", { agentsPerBox: 3, maxBoxes: 3 })
    const captain = await mcpAs(r, { kind: "captain", projectId: p.id })
    const create = (title: string, runs_on: string) => captain("create_task", { project: p.id, title, prompt: "keep going [hang]", runs_on })
    const small = await create("Small CPU", "daytona-small")
    await working(r, small.id)
    const large = await create("Large CPU", "daytona:cpu-large")
    const t = await working(r, large.id)
    expect(t.gpu).toEqual({ provider: "daytona", type: "CPU", size: "cpu-large" })
    expect(boxOf(r, large.id)).not.toBe(boxOf(r, small.id))
    expect(r.daytona.pods.get(boxOf(r, large.id)!)).toMatchObject({ vcpus: 8, memoryGb: 16, diskGb: 30 })
    expect(r.daytona.pricedSizes).toEqual(expect.arrayContaining(["cpu-small", "cpu-large"]))
    const medium = await create("Medium CPU", "daytona-medium")
    await working(r, medium.id)
    expect(boxOf(r, medium.id)).toBe(boxOf(r, large.id))
    expect(r.daytona.started).toHaveLength(2)
  })

  it("runs a task on its own cloud and GPU (@gpu:daytona:h100), on pods with that GPU only", async () => {
    const r = await start()
    const p = await gpuProject(r, "mixed", { agentsPerBox: 2, maxBoxes: 3 })
    const captain = await mcpAs(r, { kind: "captain", projectId: p.id })
    const create = (title: string, runs_on: string) => captain("create_task", { project: p.id, title, prompt: "keep going [hang]", runs_on })

    // Plain "gpu" is the project's cloud (Settings' Default GPU cloud, RunPod here).
    const plain = await create("plain", "gpu")
    await working(r, plain.id)
    expect(boxOf(r, plain.id)).toBe(gpuBoxIdOn("runpod", p.id))

    // Its own cloud and GPU: a Daytona sandbox made with an H100, whatever Settings › Daytona's types are.
    const h100 = await create("h100", "gpu:daytona:h100")
    const t = await working(r, h100.id)
    expect(t.gpu).toEqual({ provider: "daytona", type: "H100" })
    expect(boxOf(r, h100.id)).toBe(gpuBoxIdOn("daytona", p.id))
    expect(r.daytona.pods.get(gpuBoxIdOn("daytona", p.id))?.gpu?.id).toBe("H100")

    // Another GPU doesn't share that sandbox's free slot: it gets one of its own.
    const rtx = await create("rtx", "gpu:daytona:rtx-4090")
    await working(r, rtx.id)
    expect(boxOf(r, rtx.id)).toBe(gpuBoxIdOn("daytona", p.id, 2))
    expect(r.daytona.pods.get(gpuBoxIdOn("daytona", p.id, 2))?.gpu?.id).toBe("RTX-4090")

    // Any GPU on the cloud takes a free slot on one that's up.
    const any = await create("any daytona", "gpu:daytona")
    await working(r, any.id)
    expect([gpuBoxIdOn("daytona", p.id), gpuBoxIdOn("daytona", p.id, 2)]).toContain(boxOf(r, any.id))
    expect(r.daytona.started).toHaveLength(2)
    expect(r.runpod.started).toEqual([gpuBoxIdOn("runpod", p.id)])

    // A GPU the cloud doesn't have, or a cloud that isn't one, is a typo with the right names.
    expect(await create("typo", "gpu:daytona:a100")).toMatch(/Daytona has no GPU called "a100": pick one of gpu:daytona:rtx-4090, .*gpu:daytona:h100.*gpu:daytona:cpu/)
    expect(await create("cloud typo", "gpu:lambda")).toMatch(/names no GPU cloud/)
  })

  it("meters its sandboxes into the day's cloud spend (RunPod's pods aren't), and starts no new one at the daily limit", async () => {
    // The preceding hour must belong to today, including when this runs just after midnight.
    // Keep Date.now advancing so polling deadlines still use elapsed real time.
    const wallNow = Date.now.bind(Date)
    const noon = new Date(wallNow())
    noon.setHours(12, 0, 0, 0)
    const shift = noon.getTime() - wallNow()
    const clock = vi.spyOn(Date, "now").mockImplementation(() => wallNow() + shift)
    try {
      const r = await start()
      const a = await gpuProject(r, "alpha", { gpuProvider: "daytona", agentsPerBox: 1 })
      const rp = await gpuProject(r, "rp", { gpuProvider: "runpod", agentsPerBox: 1 })
      const t1 = await hang(r, a.id, "a1")
      await working(r, t1)
      await working(r, await hang(r, rp.id, "rp1"))
      // Its sandbox has been up an hour at $1/hr: $1 so far.
      const box = gpuBoxIdOn("daytona", a.id)
      r.daytona.pods.get(box)!.startedAt = new Date(Date.now() - 60 * 60_000).toISOString()
      await sweep(r, Date.now())
      const spend = r.yard.tasks.cloudSpend(true)
      expect(spend.todayUsd).toBeGreaterThan(0.99)
      expect(spend.todayUsd).toBeLessThan(1.01)
      const usage = r.yard.store.boxSpendSince(0, r.yard.settings.get().costRates).byBox
      expect([...usage.keys()]).toEqual([box])

      // At the limit, a second sandbox waits with the one-click raise; the running one goes on.
      r.yard.settings.update({ budget: { dailyUsd: 0.5, monthlyUsd: 0 } })
      r.yard.tasks.cloudSpend(true)
      const t2 = await hang(r, a.id, "a2")
      const held = await until(r, t2, (t) => t.status === "queued" && /count toward the cloud limit/.test(t.waitReason ?? ""), "to wait at the cloud limit")
      expect(held.waitReason).toMatch(/^Waiting: Daytona sandboxes count toward the cloud limit, and today's/)
      expect(held.waitFix).toBe("raise-cloud-limit")
      expect(r.daytona.started).toHaveLength(1)
      expect((await getTask(r, t1)).status).toBe("working")

      // A higher limit (Settings › Usage) lets it start.
      r.yard.settings.update({ budget: { dailyUsd: 5, monthlyUsd: 0 } })
      r.yard.tasks.cloudSpend(true)
      r.yard.tasks.schedule()
      await working(r, t2)
      expect(boxOf(r, t2)).toBe(gpuBoxIdOn("daytona", a.id, 2))
    } finally {
      clock.mockRestore()
    }
  })

  it("meters each minute only once", async () => {
    const r = await start()
    const a = await gpuProject(r, "alpha", { gpuProvider: "daytona", agentsPerBox: 1 })
    await working(r, await hang(r, a.id, "a1"))
    const box = gpuBoxIdOn("daytona", a.id)
    // Sweeps an hour ahead, so Box Yard's own (now) don't run between them.
    const t0 = Date.now() + 60 * 60_000
    await sweep(r, t0)
    await sweep(r, t0 + 30_000)
    await sweep(r, t0 + 61_000)
    await sweep(r, t0 + 122_000)
    const cost = r.yard.store.boxSpendSince(0, r.yard.settings.get().costRates).byBox.get(box)!.costUsd
    // From its start to the last sweep at $1/hr, each stretch once.
    const up = t0 + 122_000 - Date.parse(r.daytona.pods.get(box)!.startedAt!)
    expect(cost).toBeCloseTo(up / 3_600_000, 6)
  })

  it("delete_box says a Daytona sandbox's disk goes with it", async () => {
    const r = await start()
    const p = await gpuProject(r, "game", { gpuProvider: "daytona", agentsPerBox: 1 })
    const t = await hang(r, p.id, "a")
    await working(r, t)
    await r.yard.tasks.stopTask(t)
    await waitFor(() => !r.yard.store.getTaskRow(t)?.current_turn_id, "it to stop")
    const captain = await mcpAs(r, { kind: "captain", projectId: p.id })
    const res = await captain("delete_box", { box: boxOf(r, t), reason: "Done here" })
    expect(res.volume).toMatch(/^none \(a Daytona sandbox's disk goes with it/)
    expect(r.daytona.terminated).toEqual([gpuBoxIdOn("daytona", p.id)])
    const pool = await captain("pool_status")
    expect(JSON.stringify(pool.gpu_projects?.game ?? {})).toMatch(/Daytona/)
  })

  it("serves Settings › Daytona without a key and never calls Daytona for it", async () => {
    const r = await start()
    const status = await call<DaytonaStatus>(r, "GET", "/api/daytona")
    expect(status).toMatchObject({ apiKey: false, sandboxes: [], problem: "Add a Daytona API key to run projects on Daytona sandboxes", cpuImage: "ubuntu:24.04" })
    const saved = await call<DaytonaStatus>(r, "PUT", "/api/daytona/settings", { maxHourlyUsd: 5, gpuTypes: ["CPU"] })
    expect(saved.settings).toMatchObject({ maxHourlyUsd: 5, gpuTypes: ["CPU"] })
    await expect(call(r, "PUT", "/api/daytona/settings", { gpuTypes: ["CPU", "H100"] })).rejects.toThrow(/400/)
    await expect(call(r, "PUT", "/api/daytona/settings", { apiKey: "dtn_x" })).rejects.toThrow(/400/)
    await expect(call(r, "POST", "/api/daytona/sandboxes/vastai-prj_x/keep-warm", { minutes: 60 })).rejects.toThrow(/404/)
    expect(r.daytonaCalls).toEqual([])
  })
})
