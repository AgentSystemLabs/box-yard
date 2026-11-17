import { afterEach, describe, expect, it } from "vitest"
import { execFile } from "node:child_process"
import net from "node:net"
import { PREVIEW_CHECK_MS, PREVIEW_GRACE_MS, PreviewWatch, parsePortProbe, portProbeCommand, type PreviewWatchDeps } from "../server/previewWatch.js"
import type { PreviewLink } from "../shared/types.js"

// A task's preview leaves its header once nothing answers on its port (PreviewWatch): two closed looks in a row, a
// confirming look after the first, so a restarting server stays. It comes back when the port answers again. Looks run
// at a turn's end, while a turn runs, and while the task's page is open, never on a sleeping box.

const link = (port: number, url = `http://localhost:${port}`): PreviewLink => ({ port, url, label: `Port ${port}` })

function harness(opts: { previews?: PreviewLink[]; boxId?: string | null; awake?: boolean } = {}) {
  let now = 1_000_000
  const task = { boxId: opts.boxId === undefined ? "box-1" : opts.boxId, previews: opts.previews ?? [link(4870)] }
  let listening = new Set<number>()
  const probes: { boxId: string; ports: number[] }[] = []
  const updates: { previews: PreviewLink[]; down: number[]; back: number[] }[] = []
  let probeResult: () => Set<number> | null = () => new Set(listening)
  let relinks = 0
  const deps: PreviewWatchDeps = {
    task: () => ({ ...task }),
    probe: async (boxId, ports) => {
      probes.push({ boxId, ports })
      return probeResult()
    },
    awake: () => opts.awake ?? true,
    relink: async (_boxId, l) => ({ ...l, url: `${l.url}?fresh=${++relinks}` }),
    update: (_taskId, previews, change) => {
      task.previews = previews
      updates.push({ previews, down: change.down.map((p) => p.port), back: change.back.map((p) => p.port) })
    },
    now: () => now,
    confirmMs: 60_000_000, // the tests take the second look themselves
  }
  const watch = new PreviewWatch(deps)
  watches.push(watch)
  return {
    watch,
    task,
    probes,
    updates,
    listen: (...ports: number[]) => (listening = new Set(ports)),
    failProbe: () => (probeResult = () => null),
    advance: (ms: number) => (now += ms),
  }
}

const watches: PreviewWatch[] = []
afterEach(() => {
  for (const w of watches.splice(0)) w.stop()
})

describe("PreviewWatch", () => {
  it("drops a preview whose port is closed at a turn's end and again at the second look", async () => {
    const h = harness({ previews: [link(4870), link(4871)] })
    h.listen(4871)
    await h.watch.check("t", "turn_end")
    // Closed once: maybe a server restarting, so it stays until the second look.
    expect(h.updates).toEqual([])
    expect(h.task.previews.map((p) => p.port)).toEqual([4870, 4871])
    await h.watch.check("t", "confirm")
    expect(h.updates).toEqual([{ previews: [link(4871)], down: [4870], back: [] }])
    expect(h.probes.map((p) => p.ports)).toEqual([
      [4870, 4871],
      [4870, 4871],
    ])
  })

  it("keeps a preview whose server was only restarting", async () => {
    const h = harness()
    await h.watch.check("t", "turn_end")
    h.listen(4870)
    await h.watch.check("t", "confirm")
    // A later closed look starts counting again from one.
    h.listen()
    await h.watch.check("t", "turn_end")
    expect(h.updates).toEqual([])
    expect(h.task.previews).toEqual([link(4870)])
  })

  it("brings a dropped preview back with a fresh URL when its port answers again, and drops it again when it stops", async () => {
    const h = harness()
    await h.watch.check("t", "turn_end")
    await h.watch.check("t", "confirm")
    expect(h.task.previews).toEqual([])
    expect(h.watch.hasDropped("t")).toBe(true)
    // With no preview left, a look still asks after the dropped port.
    h.listen(4870)
    await h.watch.check("t", "turn_end")
    expect(h.updates.at(-1)).toEqual({ previews: [link(4870, "http://localhost:4870?fresh=1")], down: [], back: [4870] })
    expect(h.watch.hasDropped("t")).toBe(false)
    h.listen()
    await h.watch.check("t", "turn_end")
    await h.watch.check("t", "confirm")
    expect(h.updates.at(-1)?.down).toEqual([4870])
  })

  it("gives a port reported moments ago time to start listening", async () => {
    const h = harness()
    h.watch.reported("t", "box-1", 4870)
    await h.watch.check("t", "turn_end")
    await h.watch.check("t", "confirm")
    expect(h.updates).toEqual([])
    h.advance(PREVIEW_GRACE_MS)
    await h.watch.check("t", "confirm")
    await h.watch.check("t", "confirm")
    expect(h.updates.map((u) => u.down)).toEqual([[4870]])
  })

  it("a port reported again is live: a closed look before doesn't count, and it's no longer dropped", async () => {
    const h = harness()
    await h.watch.check("t", "turn_end")
    h.advance(PREVIEW_GRACE_MS + 1)
    await h.watch.check("t", "confirm")
    expect(h.watch.hasDropped("t")).toBe(true)
    // The agent reports it again (report_preview): upsertPreview stores the link, the watch forgets the drop.
    h.task.previews = [link(4870)]
    h.watch.reported("t", "box-1", 4870)
    expect(h.watch.hasDropped("t")).toBe(false)
    h.advance(PREVIEW_GRACE_MS + 1)
    await h.watch.check("t", "turn_end")
    expect(h.updates).toHaveLength(1)
  })

  it("rate-limits routine looks per task and never looks at a box that isn't up", async () => {
    const h = harness()
    h.listen(4870)
    await h.watch.check("t", "viewer")
    await h.watch.check("t", "working")
    await h.watch.check("t", "viewer")
    expect(h.probes).toHaveLength(1)
    h.advance(PREVIEW_CHECK_MS)
    await h.watch.check("t", "viewer")
    expect(h.probes).toHaveLength(2)
    // A turn's end always looks: its runner is up.
    await h.watch.check("t", "turn_end")
    expect(h.probes).toHaveLength(3)

    const asleep = harness({ awake: false })
    await asleep.watch.check("t", "viewer")
    await asleep.watch.check("t", "working")
    expect(asleep.probes).toEqual([])
  })

  it("asks nothing for a task with no preview, or one with no box (archived)", async () => {
    const none = harness({ previews: [] })
    await none.watch.check("t", "turn_end")
    await none.watch.check("t", "viewer")
    expect(none.probes).toEqual([])
    const archived = harness({ boxId: null })
    await archived.watch.check("t", "turn_end")
    expect(archived.probes).toEqual([])
  })

  it("changes nothing when the runner can't say", async () => {
    const h = harness()
    h.failProbe()
    await h.watch.check("t", "turn_end")
    await h.watch.check("t", "confirm")
    await h.watch.check("t", "confirm")
    expect(h.updates).toEqual([])
    expect(h.task.previews).toEqual([link(4870)])
  })

  it("forgets what it dropped once the task moves to another runner", async () => {
    const h = harness()
    await h.watch.check("t", "turn_end")
    await h.watch.check("t", "confirm")
    expect(h.watch.hasDropped("t")).toBe(true)
    h.task.boxId = "box-2"
    h.listen(4870)
    await h.watch.check("t", "turn_end")
    // Nothing to look for on the new runner: the preview it dropped was the old one's.
    expect(h.watch.hasDropped("t")).toBe(false)
    expect(h.probes.map((p) => p.boxId)).toEqual(["box-1", "box-1"])
    expect(h.updates.map((u) => u.down)).toEqual([[4870]])
  })

  it("takes the second look on its own after confirmMs", async () => {
    let now = 0
    const previews = [link(4870)]
    const updates: number[][] = []
    const watch = new PreviewWatch({
      task: () => ({ boxId: "box-1", previews }),
      probe: async () => new Set(),
      awake: () => true,
      relink: async (_b, l) => l,
      update: (_t, next, change) => {
        previews.splice(0, previews.length, ...next)
        updates.push(change.down.map((p) => p.port))
      },
      now: () => (now += 1),
      confirmMs: 20,
    })
    watches.push(watch)
    await watch.check("t", "turn_end")
    await new Promise((r) => setTimeout(r, 120))
    expect(updates).toEqual([[4870]])
  })
})

describe("port probe", () => {
  const servers: net.Server[] = []
  afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise((r) => s.close(r))
  })
  const listen = (host: string) =>
    new Promise<number>((resolve, reject) => {
      const s = net.createServer((c) => c.destroy())
      servers.push(s)
      s.once("error", reject)
      s.listen(0, host, () => resolve((s.address() as net.AddressInfo).port))
    })
  const run = (ports: number[]) =>
    new Promise<Set<number> | null>((resolve) => {
      execFile("bash", ["-c", portProbeCommand(process.execPath, ports)], (err, stdout) => resolve(parsePortProbe(err ? 1 : 0, stdout)))
    })

  it("finds the ports something listens on, on IPv4 or IPv6 loopback, and not the closed ones", async () => {
    const v4 = await listen("127.0.0.1")
    const all = await listen("0.0.0.0")
    const ipv6 = await listen("::1").catch(() => null)
    const closed = await listen("127.0.0.1")
    await new Promise((r) => servers.at(-1)!.close(r))
    servers.pop()
    const ports = [v4, all, closed, ...(ipv6 ? [ipv6] : [])]
    expect(await run(ports)).toEqual(new Set([v4, all, ...(ipv6 ? [ipv6] : [])]))
  })

  it("reads only a JSON list of ports, from the last line", () => {
    expect(parsePortProbe(0, "noise\n[4870, 4872]\n")).toEqual(new Set([4870, 4872]))
    expect(parsePortProbe(0, "[]")).toEqual(new Set())
    expect(parsePortProbe(1, "[4870]")).toBeNull()
    expect(parsePortProbe(0, "bash: node: command not found")).toBeNull()
    expect(parsePortProbe(0, '["4870"]')).toBeNull()
    expect(portProbeCommand("node", [4870, Number.NaN, 70000, 4871])).toMatch(/ 4870 4871$/)
  })
})
