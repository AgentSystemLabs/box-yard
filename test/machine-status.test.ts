// When each SSH machine last answered and was last tried (MachineService.status's seenAt and checkedAt), through a
// fake ssh: no machine is reached.
import { afterEach, describe, expect, it, vi } from "vitest"
import { openDb } from "../server/db.js"
import { testFromProbe, parseProbe } from "../server/machines/probe.js"
import { type MachineTransport } from "../server/machines/provider.js"
import { MachineService } from "../server/machines/service.js"
import { SSH_FAILED } from "../server/machines/ssh.js"
import { machineBoxId } from "../shared/machines.js"
import { tmpDir } from "./helpers.js"

afterEach(() => vi.useRealTimers())

function setup() {
  let down = false
  const transport: MachineTransport = {
    kind: "ssh",
    run: async () =>
      down
        ? { exitCode: SSH_FAILED, stdout: Buffer.from(""), stderr: "ssh: connect to host 192.168.1.40 port 2222: Connection timed out\n" }
        : { exitCode: 0, stdout: Buffer.from("boxyard-ok\n"), stderr: "" },
  }
  const dir = tmpDir("by-machine-status-")
  const kv = new Map<string, string>()
  const service = new MachineService({ db: openDb(dir, ":memory:"), store: { getKv: (k) => kv.get(k) ?? null, setKv: (k, v) => void kv.set(k, v) }, dataDir: dir, transport })
  const m = service.registry.add({ name: "gaming-pc", host: "192.168.1.40", port: 2222, user: "boxyard", keyRef: "default" })
  const status = () => service.status(() => ({ running: 0, tasks: 0 })).machines[0]!
  return { service, m, status, setDown: (v: boolean) => void (down = v) }
}

const passed = (at: number) =>
  testFromProbe({
    first: parseProbe("BOXYARD_PROBE\nuname=Linux 6.8 x86_64\nworkdir=/home/boxyard/boxyard\n"),
    tools: parseProbe("BOXYARD_PROBE\npath_git=/usr/bin/git\nversion_git=git version 2.43.0\npath_node=/usr/bin/node\nversion_node=v22.1.0\npath_claude=/usr/bin/claude\nversion_claude=2.0.14 (Claude Code)\n"),
    pathDirs: [],
    latencyMs: 1,
    at,
  })

describe("an SSH machine's last answer", () => {
  it("is never for an untested machine", () => {
    expect(setup().status()).toMatchObject({ state: "untested", seenAt: null, checkedAt: null })
  })

  it("is its passing test until Box Yard reaches it again, then that", async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const { service, m, status } = setup()
    service.registry.setTest(m.id, passed(900_000))
    expect(status()).toMatchObject({ state: "ready", seenAt: 900_000, checkedAt: 900_000 })
    vi.setSystemTime(1_060_000)
    await service.provider.health(machineBoxId(m.id))
    expect(status()).toMatchObject({ state: "ready", seenAt: 1_060_000, checkedAt: 1_060_000 })
  })

  it("stays at the last time it answered while it doesn't, and the last try moves on", async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const { service, m, status, setDown } = setup()
    service.registry.setTest(m.id, passed(900_000))
    await service.provider.health(machineBoxId(m.id))
    setDown(true)
    vi.setSystemTime(1_120_000)
    await service.provider.health(machineBoxId(m.id))
    vi.setSystemTime(1_180_000)
    await service.provider.health(machineBoxId(m.id))
    expect(status()).toMatchObject({
      state: "offline",
      problem: "Box Yard can't reach it (connect to host 192.168.1.40 port 2222: Connection timed out)",
      seenAt: 1_000_000,
      checkedAt: 1_180_000,
    })
  })

  it("is never when its only test failed", async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const { service, m, status, setDown } = setup()
    setDown(true)
    await service.test(m.id)
    expect(status()).toMatchObject({ state: "offline", seenAt: null, checkedAt: 1_000_000 })
    expect(status().problem).toBe("Can't connect: connect to host 192.168.1.40 port 2222: Connection timed out")
  })
})
