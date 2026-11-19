import { describe, expect, it } from "vitest"
import type { CredentialStore } from "../server/credentials.js"
import type { Config } from "../server/config.js"
import {
  BOXD_BOX_PREFIX,
  BoxdProvider,
  boxdIsGone,
  boxdLabelPairs,
  boxdMachineId,
  type BoxdClient,
} from "../server/providers/boxd.js"
import { testConfig } from "./helpers.js"

// boxd machines as worker boxes (docs/boxd.md). Nothing here talks to boxd: every call goes to a fake client
// that keeps machines and snapshots in memory. Never point these at the real API: a machine spends money from
// the moment it's made. The real end-to-end check is scripts/smoke-boxd.ts, run by hand.

const KEY = "bxd_secret_test_key_0123456789"

/** The kind of error the boxd API answers for a machine that isn't there. */
const goneError = () => Object.assign(new Error("machine not found"), { code: "NOT_FOUND" })

interface FakeMachine {
  id: string
  name: string
  status: string
  labels?: Record<string, string>
  isolated?: boolean
  resources?: { vcpu: number }
}

interface FakeSnapshot {
  name: string
  status: "saving" | "ready" | "failed"
  sizeBytes?: number
}

interface FakeBoxd {
  client: BoxdClient
  machines: FakeMachine[]
  created: Record<string, unknown>[]
  listedLabels: (Record<string, string> | undefined)[]
  waited: string[]
  woken: string[]
  deleted: string[]
  resized: { id: string; vcpu: number }[]
  execs: { id: string; command: unknown }[]
  uploads: { id: string; path: string; data: unknown }[]
  proxies: { id: string; name: string; port: number; domain: string; isDefault: boolean }[]
  snapshotCreated: { id: string; name: string }[]
  snapshotDeleted: string[]
  closed: number
  /** What a command answers; the default is success with no output. */
  answer: (id: string, command: unknown) => { exitCode: number; stdout: string; stderr: string } | null
}

/** boxd as the provider sees it: machines, snapshots and proxies in memory, every call recorded. */
function fakeBoxd(o: { machines?: FakeMachine[]; snapshots?: FakeSnapshot[] } = {}): FakeBoxd {
  const machines = [...(o.machines ?? [])]
  const snapshots = [...(o.snapshots ?? [])]
  const files = new Map<string, unknown>()
  const f: FakeBoxd = {
    client: null as never,
    machines,
    created: [],
    listedLabels: [],
    waited: [],
    woken: [],
    deleted: [],
    resized: [],
    execs: [],
    uploads: [],
    proxies: [],
    snapshotCreated: [],
    snapshotDeleted: [],
    closed: 0,
    answer: () => null,
  }
  let next = 0
  const run = (id: string, command: unknown) => f.answer(id, command) ?? { exitCode: 0, success: true, stdout: "", stderr: "" }
  f.client = {
    machines: {
      create: async (params: Record<string, unknown> & { name: string }) => {
        f.created.push(params)
        const machine: FakeMachine = {
          id: `m${(++next).toString().padStart(4, "0")}`,
          name: params.name,
          status: "running",
          labels: params.labels as Record<string, string> | undefined,
          isolated: params.isolated as boolean | undefined,
        }
        machines.push(machine)
        return machine
      },
      get: async (id: string) => {
        const found = machines.find((m) => m.id === id || m.name === id)
        if (!found) throw goneError()
        return found
      },
      list: async (params?: { labels?: Record<string, string> }) => {
        f.listedLabels.push(params?.labels)
        return machines.filter((m) => {
          if (m.status === "destroyed") return false
          const want = params?.labels ?? {}
          return Object.entries(want).every(([k, v]) => m.labels?.[k] === v)
        })
      },
      delete: async (id: string) => {
        const found = machines.find((m) => m.id === id || m.name === id)
        if (!found) throw goneError()
        found.status = "destroyed"
        f.deleted.push(id)
      },
      wake: async (id: string) => {
        f.woken.push(id)
        const found = machines.find((m) => m.id === id)
        if (found) found.status = "running"
      },
      exec: async (id: string, params: { command: unknown }) => {
        f.execs.push({ id, command: params.command })
        return run(id, params.command)
      },
      waitUntilReady: async (id: string) => {
        f.waited.push(id)
        const found = machines.find((m) => m.id === id)
        if (!found) throw goneError()
        return found
      },
      resize: async (id: string, params: { vcpu: number }) => {
        f.resized.push({ id, vcpu: params.vcpu })
        const found = machines.find((m) => m.id === id)
        if (found) found.resources = { vcpu: params.vcpu }
      },
      files: {
        upload: async (id: string, path: string, data: unknown) => {
          f.uploads.push({ id, path, data })
          files.set(`${id}:${path}`, data)
        },
        download: async (id: string, path: string) => {
          const data = files.get(`${id}:${path}`)
          if (data === undefined) throw goneError()
          return data as Uint8Array
        },
      },
      proxies: {
        list: async (id: string) => [
          { domain: `${id}.boxd.test`, port: 443, isDefault: true },
          ...f.proxies.filter((p) => p.id === id),
        ],
        create: async (id: string, name: string, port: number) => {
          f.proxies.push({ id, name, port, domain: `${name}-${id}.boxd.test`, isDefault: false })
        },
      },
    },
    snapshots: {
      create: async (id: string, name: string) => {
        f.snapshotCreated.push({ id, name })
        snapshots.push({ name, status: "ready", sizeBytes: 1234 })
      },
      get: async (name: string) => snapshots.find((s) => s.name === name),
      delete: async (name: string) => {
        f.snapshotDeleted.push(name)
        const i = snapshots.findIndex((s) => s.name === name)
        if (i >= 0) snapshots.splice(i, 1)
      },
    },
    close: async () => {
      f.closed++
    },
  } as unknown as BoxdClient
  return f
}

/** The provider on a fake boxd, with the key from the env slot (no credential store, so no network at all). */
const prov = (f: FakeBoxd, overrides: Partial<Config> = {}) =>
  new BoxdProvider(testConfig({ boxdApiKey: KEY, ...overrides }), undefined, async () => f.client)

describe("boxdLabelPairs", () => {
  it("maps the yard's string labels to boxd's key=value pairs: the part before the first dash is the key", () => {
    expect(boxdLabelPairs(["boxyard", "by-a1b2", "p-my-proj", "snapshot-scratch"])).toEqual({
      boxyard: "boxyard",
      by: "by-a1b2",
      p: "p-my-proj",
      snapshot: "snapshot-scratch",
    })
    expect(boxdLabelPairs(["smoke"])).toEqual({ smoke: "smoke" })
  })

  it("drops labels whose key boxd would refuse, and empty ones", () => {
    expect(boxdLabelPairs(["", "UPPER-case", "a".repeat(64)])).toEqual({})
  })
})

describe("BoxdProvider", () => {
  it("creates an isolated machine with the yard's labels, waits for it, runs the setup script and hands out a boxd- id", async () => {
    const f = fakeBoxd()
    const p = prov(f)
    const id = await p.create({ labels: ["boxyard", "by-a1b2", "p-proj"], size: "medium" })
    expect(id.startsWith(BOXD_BOX_PREFIX)).toBe(true)
    expect(f.created[0]).toMatchObject({
      isolated: true,
      labels: { boxyard: "boxyard", by: "by-a1b2", p: "p-proj" },
      env: { DISABLE_AUTOUPDATER: "1", IS_SANDBOX: "1" },
      config: { vcpu: 2, memory: "8G" },
    })
    expect(f.created[0]!.name.startsWith("byard-")).toBe(true)
    expect(f.waited).toEqual([boxdMachineId(id)])
    // The setup script ran on the machine, in a plain shell with the tools folder on PATH.
    expect(f.execs[0]!.id).toBe(boxdMachineId(id))
    expect(f.execs[0]!.command).toEqual(["bash", "-c", expect.stringContaining("git config --global init.defaultBranch main")])
    expect((f.execs[0]!.command as string[])[2]).toContain('PATH="$HOME/.local/bin:$PATH"')
  })

  it("restores a snapshot isolated too, with the labels merged in and the boxd- prefix stripped from the snapshot id", async () => {
    const f = fakeBoxd()
    const p = prov(f)
    const id = await p.create({ labels: ["by-a1b2"], snapshotId: "boxd-mysnap" })
    expect(f.created[0]).toMatchObject({ fromSnapshot: "mysnap", isolated: true, labels: { by: "by-a1b2" } })
    expect(id.startsWith(BOXD_BOX_PREFIX)).toBe(true)
  })

  it("destroys the machine it made when the worker setup fails", async () => {
    const f = fakeBoxd()
    f.answer = () => ({ exitCode: 1, stdout: "", stderr: "nope" })
    const p = prov(f)
    await expect(p.create({ labels: ["by-a1b2"] })).rejects.toThrow("worker setup failed")
    expect(f.deleted).toHaveLength(1)
    expect(f.machines.every((m) => m.status === "destroyed")).toBe(true)
  })

  it("listIds returns only machines with this install's label, as box ids: never another install's or a script's", async () => {
    const ours = { id: "m0001", name: "byard-aaaa1", status: "running", labels: { by: "by-a1b2" } }
    const otherInstall = { id: "m0002", name: "byard-bbbb2", status: "running", labels: { by: "by-other9" } }
    const unlabeled = { id: "m0003", name: "byard-cccc3", status: "running" }
    const notOurs = { id: "m0004", name: "my-own-machine", status: "running" }
    const f = fakeBoxd({ machines: [ours, otherInstall, unlabeled, notOurs] })
    const p = prov(f)
    expect(await p.listIds("by-a1b2")).toEqual(["boxd-m0001"])
    expect(f.listedLabels).toEqual([{ by: "by-a1b2" }])
  })

  it("liveIds returns every byard-named machine, labeled or not, destroyed ones out, as box ids", async () => {
    const a = { id: "m0001", name: "byard-aaaa1", status: "running", labels: { by: "by-other9" } }
    const b = { id: "m0002", name: "byard-bbbb2", status: "destroyed" }
    const c = { id: "m0003", name: "my-own-machine", status: "running" }
    const f = fakeBoxd({ machines: [a, b, c] })
    const p = prov(f)
    expect(await p.liveIds()).toEqual(["boxd-m0001"])
  })

  it("health maps boxd's statuses, and a machine that isn't there is gone", async () => {
    const m = { id: "m0001", name: "byard-aaaa1", status: "running" }
    const f = fakeBoxd({ machines: [m] })
    const p = prov(f)
    expect(await p.health("boxd-m0001")).toBe("running")
    for (const [status, want] of [
      ["destroyed", "gone"],
      ["failed", "error"],
      ["migrating", "unknown"],
      ["suspended", "paused"],
      ["hibernated", "paused"],
      ["stopped", "paused"],
      ["pending", "running"],
    ] as const) {
      m.status = status
      expect(await p.health("boxd-m0001")).toBe(want)
    }
    expect(await p.health("boxd-nope")).toBe("gone")
  })

  it("wake wakes a paused machine, and only a paused one", async () => {
    const m = { id: "m0001", name: "byard-aaaa1", status: "suspended" }
    const f = fakeBoxd({ machines: [m] })
    const p = prov(f)
    await p.wake("boxd-m0001")
    expect(f.woken).toEqual(["m0001"])
    f.woken.length = 0
    m.status = "running"
    await p.wake("boxd-m0001")
    expect(f.woken).toEqual([])
  })

  it("exec runs bash -c with the tools folder on PATH, and keeps the exit code it gets", async () => {
    const f = fakeBoxd()
    const p = prov(f)
    f.answer = () => ({ exitCode: 3, success: false, stdout: "out", stderr: "err" })
    const r = await p.exec("boxd-m0001", "ls -la")
    expect(r).toEqual({ exitCode: 3, stdout: "out", stderr: "err" })
    expect(f.execs[0]!.id).toBe("m0001")
    expect(f.execs[0]!.command).toEqual(["bash", "-c", 'PATH="$HOME/.local/bin:$PATH"; ls -la'])
  })

  it("writes and reads files on the machine the box id names", async () => {
    const f = fakeBoxd()
    const p = prov(f)
    await p.writeFile("boxd-m0001", "/home/boxd/yard/tasks/t1/task.json", '{"a":1}')
    // The folder is made with a plain shell first, then the file goes up through the API.
    expect(f.execs[0]!.command).toEqual(["bash", "-c", "PATH=\"$HOME/.local/bin:$PATH\"; mkdir -p '/home/boxd/yard/tasks/t1'"])
    expect(f.uploads[0]).toMatchObject({ id: "m0001", path: "/home/boxd/yard/tasks/t1/task.json" })
    expect((await p.readFile("boxd-m0001", "/home/boxd/yard/tasks/t1/task.json")).toString("utf8")).toBe('{"a":1}')
  })

  it("a preview URL is a p<port> subdomain proxy, made once and reused for the port", async () => {
    const f = fakeBoxd()
    const p = prov(f)
    const url = await p.publicUrl("boxd-m0001", 3000)
    expect(url).toBe("https://p3000-m0001.boxd.test")
    expect(await p.publicUrl("boxd-m0001", 3000)).toBe(url)
    expect(f.proxies).toEqual([{ id: "m0001", name: "p3000", port: 3000, domain: "p3000-m0001.boxd.test", isDefault: false }])
  })

  it("a snapshot's id is its name with the boxd- prefix, and it waits for the capture", async () => {
    const f = fakeBoxd()
    const p = prov(f)
    const snap = await p.snapshot("boxd-m0001", "proj-snap")
    expect(snap).toEqual({ id: "boxd-proj-snap", bytes: 1234 })
    expect(f.snapshotCreated).toEqual([{ id: "m0001", name: "proj-snap" }])
    // Deleting takes the prefixed id or the bare name, and a snapshot that's already gone is fine.
    await p.deleteSnapshot("boxd-proj-snap")
    expect(f.snapshotDeleted).toEqual(["proj-snap"])
    await expect(p.deleteSnapshot("")).rejects.toThrow("deleteSnapshot needs a snapshot id")
    await expect(p.deleteSnapshot("boxd-gone-already")).resolves.toBeUndefined()
  })

  it("destroy deletes the machine the box id names, and one that's already gone is fine", async () => {
    const m = { id: "m0001", name: "byard-aaaa1", status: "running" }
    const f = fakeBoxd({ machines: [m] })
    const p = prov(f)
    await p.destroy("boxd-m0001")
    expect(f.deleted).toEqual(["m0001"])
    await expect(p.destroy("boxd-m0001")).resolves.toBeUndefined()
  })

  it("usage reads the size from the machine's vCPU and measures the disk", async () => {
    const m = { id: "m0001", name: "byard-aaaa1", status: "running", resources: { vcpu: 2 } }
    const f = fakeBoxd({ machines: [m] })
    const p = prov(f)
    f.answer = (_id, command) =>
      Array.isArray(command) && /du -sk/.test(String(command[2]))
        ? { exitCode: 0, stdout: "2048\t/home/boxd/yard\n", stderr: "" }
        : null
    expect(await p.usage("boxd-m0001")).toEqual({ size: "medium", diskBytes: 2048 * 1024, source: "estimated" })
  })

  it("resize sizes the machine the box id names by vCPU", async () => {
    const f = fakeBoxd()
    const p = prov(f)
    await p.resize("boxd-m0001", "large")
    expect(f.resized).toEqual([{ id: "m0001", vcpu: 4 }])
  })

  it("a new key drops the old client and makes a new one; the same key keeps one", async () => {
    const fakes: FakeBoxd[] = []
    const keys: string[] = []
    const saved = { key: KEY }
    const creds = { get: () => saved.key } as Pick<CredentialStore, "get">
    const p = new BoxdProvider(testConfig(), creds, async (k) => {
      keys.push(k)
      const f = fakeBoxd()
      fakes.push(f)
      return f.client
    })
    await p.health("boxd-m0001")
    await p.health("boxd-m0001")
    expect(keys).toEqual([KEY])
    saved.key = "bxd_second_key_0123456789"
    await p.health("boxd-m0001")
    expect(keys).toEqual([KEY, "bxd_second_key_0123456789"])
    // The first key's client is closed, not just dropped.
    expect(fakes[0]!.closed).toBe(1)
    expect(fakes[1]!.closed).toBe(0)
  })
})

describe("boxdIsGone", () => {
  it("knows the API's not-found shapes", () => {
    expect(boxdIsGone(Object.assign(new Error("x"), { code: 404 }))).toBe(true)
    expect(boxdIsGone(Object.assign(new Error("x"), { code: "NOT_FOUND" }))).toBe(true)
    expect(boxdIsGone(new Error("no such machine"))).toBe(true)
    expect(boxdIsGone(new Error("bad key"))).toBe(false)
  })
})
