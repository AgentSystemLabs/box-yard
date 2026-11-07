// What an offline SSH machine's card says to check (web/src/lib/machineFix.ts), from the reasons ssh gives, and how
// the runners overview counts machines by state. Nothing here reaches a machine: the errors are ssh's own words
// through sshError, the way MachineService keeps them.
import { describe, expect, it } from "vitest"
import { looksLikeWsl, machineFix, sshCommand, sshReason } from "../web/src/lib/machineFix"
import { machinesSummary } from "../web/src/lib/machines"
import { failedTest } from "../server/machines/probe"
import { sshError } from "../server/machines/ssh"
import type { MachineStatus } from "../shared/machines"

const machine = (over: Partial<MachineStatus> = {}): MachineStatus => ({
  id: "mch_1",
  name: "old-thinkpad",
  host: "thinkpad.local",
  user: "boxyard",
  port: 22,
  keyRef: "file:~/.ssh/boxyard_laptops",
  maxTasks: 1,
  labels: ["laptops"],
  dir: "~/boxyard",
  enabled: true,
  lastTest: null,
  createdAt: 1,
  updatedAt: 1,
  state: "offline",
  problem: null,
  running: 0,
  tasks: 0,
  boxId: "ssh-mch_1",
  seenAt: null,
  checkedAt: null,
  ...over,
})

/** Offline after Test connection failed with this ssh stderr (MachineService.probe's wording). */
const failed = (stderr: string, over: Partial<MachineStatus> = {}) => {
  const error = `Can't connect: ${sshError(stderr)}`
  return machine({ problem: error, lastTest: failedTest(error, 1), ...over })
}

const texts = (m: MachineStatus) => machineFix(m)!.steps.map((s) => s.text).join("\n")
const codes = (m: MachineStatus) => machineFix(m)!.steps.flatMap((s) => (s.code ? [s.code] : []))

describe("an offline machine's fix", () => {
  it("reads a WSL machine's timeout on 2222 as WSL, sshd and firewall checks", () => {
    const m = failed("ssh: connect to host 192.168.1.40 port 2222: Connection timed out\n", { name: "gaming-pc", host: "192.168.1.40", port: 2222 })
    const fix = machineFix(m)!
    expect(fix).toMatchObject({ kind: "timeout", title: "No answer from 192.168.1.40 on port 2222", detail: "connect to host 192.168.1.40 port 2222: Connection timed out", rechecked: false })
    expect(texts(m)).toMatch(/awake/)
    expect(texts(m)).toMatch(/still at 192\.168\.1\.40/)
    expect(codes(m)).toEqual([
      "sudo service ssh start",
      "netsh interface portproxy show v4tov4",
      'New-NetFirewallRule -DisplayName "SSH 2222" -Direction Inbound -Protocol TCP -LocalPort 2222 -Action Allow',
    ])
    expect(fix.command).toBe("ssh -o BatchMode=yes -p 2222 -i ~/.ssh/boxyard_laptops boxyard@192.168.1.40 true")
  })

  it("checks a Linux firewall, not WSL, for a timeout on 22", () => {
    const m = failed("ssh: connect to host thinkpad.local port 22: Operation timed out\n")
    expect(machineFix(m)!.kind).toBe("timeout")
    expect(codes(m)).toEqual(["sudo ufw allow 22/tcp"])
    expect(texts(m)).not.toMatch(/WSL/)
  })

  it("tells WSL apart by name, host or label as well as port", () => {
    const base = { name: "desk", host: "10.0.0.2", port: 22, labels: [] as string[] }
    expect(looksLikeWsl(base)).toBe(false)
    expect(looksLikeWsl({ ...base, port: 2222 })).toBe(true)
    expect(looksLikeWsl({ ...base, name: "desk-wsl" })).toBe(true)
    expect(looksLikeWsl({ ...base, labels: ["windows"] })).toBe(true)
    expect(looksLikeWsl({ ...base, host: "win.lan" })).toBe(true)
    expect(looksLikeWsl({ ...base, name: "winnie" })).toBe(false)
  })

  it("starts sshd for a refused connection: systemd on Linux, Remote Login on a Mac, the service in WSL", () => {
    const refused = "ssh: connect to host thinkpad.local port 22: Connection refused\n"
    expect(machineFix(failed(refused))).toMatchObject({ kind: "refused", title: "thinkpad.local answered, but nothing takes SSH on port 22" })
    expect(codes(failed(refused))).toEqual(["sudo systemctl enable --now ssh", "sudo sshd -T | grep -i '^port'"])
    const mac = machine({ problem: `Box Yard can't reach it (${sshError(refused)})`, lastTest: { ...failedTest("", 1), ok: true, os: "Darwin 23.4.0 arm64" } })
    expect(texts(mac)).toMatch(/Remote Login is on/)
    expect(codes(failed(refused, { port: 2222 }))).toEqual(["sudo service ssh start", "sudo sshd -T | grep -i '^port'", "netsh interface portproxy show v4tov4"])
  })

  it("names the host this computer can't find, with mDNS for a .local name", () => {
    const m = failed("ssh: Could not resolve hostname thinkpad.local: Name or service not known\n")
    expect(machineFix(m)).toMatchObject({ kind: "dns", title: "This computer can't find thinkpad.local" })
    expect(codes(m)).toEqual(["sudo apt install -y avahi-daemon"])
    expect(codes(failed("ssh: Could not resolve hostname tower: nodename nor servname provided, or not known\n", { host: "tower" }))).toEqual([])
  })

  it("reads no route to the host as the network", () => {
    const m = failed("ssh: connect to host 10.0.0.9 port 22: No route to host\n", { host: "10.0.0.9" })
    expect(machineFix(m)).toMatchObject({ kind: "route", title: "This computer has no way to reach 10.0.0.9" })
  })

  it("copies the key file's public half for a turned-down key, and asks the agent when it's the agent's", () => {
    const m = failed("Warning: Permanently added 'x' (ED25519) to the list of known hosts.\nboxyard@thinkpad.local: Permission denied (publickey).\n", { port: 2200 })
    expect(machineFix(m)).toMatchObject({ kind: "login", title: "thinkpad.local answered, but turned down the key for boxyard" })
    expect(codes(m)).toContain("ssh-copy-id -i ~/.ssh/boxyard_laptops.pub -p 2200 boxyard@thinkpad.local")
    const agent = failed("boxyard@thinkpad.local: Permission denied (publickey).\n", { keyRef: "agent" })
    expect(codes(agent)).toEqual(["ssh-add -l", "ssh-copy-id boxyard@thinkpad.local", "chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys"])
    expect(machineFix(agent)!.command).toBe("ssh -o BatchMode=yes boxyard@thinkpad.local true")
  })

  it("leaves a changed host key to Forget host key, with no command (Box Yard's known hosts aren't the terminal's)", () => {
    const m = failed("@@@@\nWARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\n@@@@\nHost key verification failed.\n")
    expect(machineFix(m)).toMatchObject({ kind: "hostkey", command: null })
    expect(texts(m)).toMatch(/Forget host key/)
  })

  it("reads a dropped connection, a slow one and a login with no bash", () => {
    expect(machineFix(failed("kex_exchange_identification: read: Connection reset by peer\n"))!.kind).toBe("closed")
    expect(machineFix(failed("Connection closed by 10.0.0.9 port 22\n"))!.kind).toBe("closed")
    expect(machineFix(failed("\n(timed out after 90 s)"))!.kind).toBe("slow")
    const shell = "It logged in but the test didn't run (exit 127: bash: not found). Box Yard needs bash on it."
    expect(machineFix(machine({ problem: shell, lastTest: failedTest(shell, 1) }))!.kind).toBe("shell")
  })

  it("falls back to running the command by hand for a reason it doesn't know", () => {
    expect(machineFix(failed("ssh failed\n"))).toMatchObject({ kind: "other", title: "Box Yard can't reach old-thinkpad" })
  })

  it("says Box Yard tries again when it answered before and stopped, and reads the reason inside the wrapper", () => {
    const reach = `Box Yard can't reach it (${sshError("ssh: connect to host pi.local port 22: Connection refused")})`
    expect(sshReason(reach)).toBe("connect to host pi.local port 22: Connection refused")
    const m = machine({ host: "pi.local", problem: reach, lastTest: { ...failedTest("", 1), ok: true } })
    expect(machineFix(m)).toMatchObject({ kind: "refused", rechecked: true, detail: "connect to host pi.local port 22: Connection refused" })
  })

  it("is only for offline machines with a reason", () => {
    for (const state of ["ready", "busy", "problem", "off", "untested"] as const) expect(machineFix(machine({ state, problem: "node isn't installed" }))).toBeNull()
    expect(machineFix(machine({ problem: null }))).toBeNull()
  })

  it("quotes a key path with spaces and keeps its ~/ outside the quotes", () => {
    expect(sshCommand({ host: "h", user: "u", port: 22, keyRef: "file:~/.ssh/my key" })).toBe("ssh -o BatchMode=yes -i ~/'.ssh/my key' u@h true")
    expect(sshCommand({ host: "h", user: "u", port: 22, keyRef: "default" })).toBe("ssh -o BatchMode=yes u@h true")
  })
})

describe("the runners overview's machine count", () => {
  it("counts by state, what needs you first", () => {
    const states = ["ready", "offline", "busy", "ready", "offline", "problem", "off", "untested"] as const
    expect(machinesSummary(states.map((state) => ({ state })))).toBe("2 offline · 1 needs setup · 1 busy · 2 ready · 1 not tested · 1 off")
    expect(machinesSummary([{ state: "ready" }])).toBe("1 ready")
    expect(machinesSummary([])).toBeNull()
  })
})
