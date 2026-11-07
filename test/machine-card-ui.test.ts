// @vitest-environment happy-dom
// An SSH machine's card (MachineCard, in Settings › Machines and on the Boxes page): when Box Yard last connected, and for an
// offline one why in plain words, what to check, and commands with a Copy button that needs no hover.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MachineCard } from "../web/src/components/MachineSettings.js"
import { failedTest } from "../server/machines/probe"
import type { MachineStatus, MachineTest } from "../shared/machines"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const MIN = 60_000
const timeout = "Can't connect: connect to host 192.168.1.40 port 2222: Connection timed out"
const passed: MachineTest = { ...failedTest("", now - 26 * 60 * MIN), ok: true, error: null, osName: "Debian 12", cpus: 4 }

const machine = (over: Partial<MachineStatus> = {}): MachineStatus => ({
  id: "mch_wsl",
  name: "gaming-pc",
  host: "192.168.1.40",
  user: "boxyard",
  port: 2222,
  keyRef: "file:~/.ssh/boxyard_laptops",
  maxTasks: 1,
  labels: ["gpu"],
  dir: "~/boxyard",
  enabled: true,
  lastTest: failedTest(timeout, now - 7 * MIN),
  createdAt: 1,
  updatedAt: 1,
  state: "offline",
  problem: timeout,
  running: 0,
  tasks: 1,
  boxId: "ssh-mch_wsl",
  seenAt: null,
  checkedAt: now - 7 * MIN,
  ...over,
})

let root: Root
let host: HTMLElement
const written: string[] = []

beforeEach(() => {
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  written.length = 0
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: async (t: string) => void written.push(t) } })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

function render(m: MachineStatus, inSettings = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(MachineCard, { machine: m, onEdit: inSettings ? () => {} : undefined }))))
}

const $ = (sel: string) => host.querySelector<HTMLElement>(sel)
const text = (sel: string) => $(sel)?.textContent?.replace(/\s+/g, " ").trim() ?? null

describe("an offline machine's card", () => {
  it("says it never connected, why in plain words, and the WSL, sshd and firewall checks", () => {
    render(machine())
    expect(text('[data-testid="machine-seen"]')).toBe("Never connected · tried 7m ago")
    const fix = $('[data-testid="machine-fix"]')!
    expect(fix.dataset.fix).toBe("timeout")
    expect(fix.textContent).toContain("No answer from 192.168.1.40 on port 2222")
    expect(fix.textContent).toContain("connect to host 192.168.1.40 port 2222: Connection timed out")
    const steps = [...fix.querySelectorAll('ol[aria-label="What to check"] > li')].map((li) => li.textContent)
    expect(steps).toHaveLength(5)
    expect(steps[2]).toContain("sudo service ssh start")
    expect(fix.textContent).toContain("Once it's fixed, Test connection.")
    // The failed test's own line would only repeat the reason and the time.
    expect(host.textContent).not.toContain("Last test")
  })

  it("copies a command with a Copy button that's there without hovering", async () => {
    render(machine())
    const copies = [...host.querySelectorAll<HTMLButtonElement>('button[aria-label="Copy command"]')]
    expect(copies).toHaveLength(4)
    for (const b of copies) expect(b.className).toContain("opacity-100!")
    await act(async () => copies.at(-1)!.click())
    expect(written).toEqual(["ssh -o BatchMode=yes -p 2222 -i ~/.ssh/boxyard_laptops boxyard@192.168.1.40 true"])
  })

  it("on the Boxes page, says where Test connection is", () => {
    render(machine(), false)
    expect(text('[data-testid="machine-fix"]')).toContain("Once it's fixed, Test connection in Settings › Machines.")
  })

  it("says when one that stopped answering last connected, and that Box Yard tries it again, above its last good test", () => {
    const reach = "Box Yard can't reach it (connect to host 192.168.1.40 port 2222: Connection refused)"
    render(machine({ problem: reach, lastTest: passed, seenAt: now - 3 * 60 * MIN, checkedAt: now - 10_000 }))
    expect(text('[data-testid="machine-seen"]')).toBe("Last connected 3h ago · tried just now")
    expect(text('[data-testid="machine-fix"]')).toContain("Box Yard tries it again every minute. Its tasks wait until it answers.")
    expect(host.textContent).toContain("Debian 12 · 4 CPUs")
  })
})

describe("a reachable machine's card", () => {
  it("says when it last connected, with no fix", () => {
    render(machine({ state: "ready", problem: null, lastTest: { ...passed, at: now - 3 * MIN }, seenAt: now - 3 * MIN, checkedAt: now - 3 * MIN }))
    expect(text('[data-testid="machine-seen"]')).toBe("Last connected 3m ago")
    expect($('[data-testid="machine-fix"]')).toBeNull()
  })

  it("shows a machine that needs setup's problem as it is", () => {
    render(machine({ state: "problem", problem: "node isn't installed (Node 18 or later runs Box Yard's runner)", lastTest: passed, seenAt: now, checkedAt: now }))
    expect($('[data-testid="machine-fix"]')).toBeNull()
    expect(host.textContent).toContain("node isn't installed")
  })

  it("says nothing about answers for one that's off or untested", () => {
    render(machine({ state: "untested", problem: null, lastTest: null, checkedAt: null }))
    expect($('[data-testid="machine-seen"]')).toBeNull()
    expect(host.textContent).toContain("Not tested yet.")
  })
})
