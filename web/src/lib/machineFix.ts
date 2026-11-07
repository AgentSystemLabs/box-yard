// What to check when an SSH machine is offline (Settings › Machines, the Boxes page): ssh's reason in plain words,
// the likely causes in the order worth checking, and Box Yard's connection as one ssh command to try by hand.
// Pure, so the tests read every hint; nothing here reaches a machine.
import type { MachineStatus } from "../../../shared/machines"

/** One thing to check, with a command that checks or fixes it on the machine (or on Windows, for WSL). */
export interface FixStep {
  text: string
  code?: string
}

export type FixKind = "timeout" | "refused" | "dns" | "route" | "login" | "hostkey" | "closed" | "slow" | "shell" | "other"

export interface MachineFix {
  kind: FixKind
  /** The reason in plain words: "No answer from 192.168.1.40 on port 2222". */
  title: string
  /** ssh's own words, as Box Yard got them. */
  detail: string
  steps: FixStep[]
  /** Box Yard's login as an ssh command for this computer's terminal, or null when it wouldn't tell more. */
  command: string | null
  /** Box Yard asks it again every minute (it answered before and stopped); otherwise Test connection does. */
  rechecked: boolean
}

type FixMachine = Pick<MachineStatus, "name" | "host" | "user" | "port" | "keyRef" | "labels" | "state" | "problem" | "lastTest">

const KINDS: [FixKind, RegExp][] = [
  ["hostkey", /host key changed|REMOTE HOST IDENTIFICATION|Host key verification failed/i],
  ["dns", /Could not resolve hostname|Name or service not known|nodename nor servname|name resolution/i],
  ["login", /Permission denied|Too many authentication failures|no mutual signature|Load key|bad permissions|UNPROTECTED PRIVATE KEY/i],
  ["refused", /Connection refused/i],
  ["route", /No route to host|Network is unreachable|Host is unreachable|Host is down/i],
  ["slow", /timed out after \d+ ?s/i],
  ["timeout", /timed out/i],
  ["closed", /Connection closed|Connection reset|kex_exchange_identification|Broken pipe/i],
  ["shell", /test didn't run|needs bash/i],
]

/** ssh's reason without the wrappers Box Yard puts around it ("Can't connect: …", "Box Yard can't reach it (…)"). */
export function sshReason(problem: string): string {
  return problem
    .trim()
    .replace(/^Can't connect: /, "")
    .replace(/^Box Yard can't reach it \((.*)\)$/s, "$1")
}

/** A machine Windows runs sshd for in WSL: its name, host or labels say so, or it's on WSL's usual forwarded port. */
export function looksLikeWsl(m: Pick<MachineStatus, "name" | "host" | "port" | "labels">): boolean {
  return m.port === 2222 || /(^|[^a-z])(wsl|windows|win)([^a-z]|$)/i.test([m.name, m.host, ...m.labels].join(" "))
}

/** A path for a shell: as is when it's plain, else quoted after its `~/`, which has to stay unquoted to expand. */
function shellPath(p: string): string {
  if (/^[\w@%+=:,./~-]+$/.test(p)) return p
  const home = p.startsWith("~/") ? "~/" : ""
  return `${home}'${p.slice(home.length).replace(/'/g, `'\\''`)}'`
}

/** The key file a `file:` key reference names, or null for the SSH agent and ssh's own config. */
const keyFile = (keyRef: string) => (keyRef.startsWith("file:") ? keyRef.slice("file:".length) : null)

/** Box Yard's login as a terminal command: no password prompt, the same port, user and key. */
export function sshCommand(m: Pick<MachineStatus, "host" | "user" | "port" | "keyRef">): string {
  const file = keyFile(m.keyRef)
  return ["ssh -o BatchMode=yes", m.port === 22 ? null : `-p ${m.port}`, file ? `-i ${shellPath(file)}` : null, `${m.user}@${m.host}`, "true"].filter(Boolean).join(" ")
}

const firewall = (port: number): FixStep => ({ text: `A firewall lets port ${port} in. On Ubuntu or Debian:`, code: `sudo ufw allow ${port}/tcp` })
const wslSshd: FixStep = { text: "sshd is running inside WSL. It stops when WSL shuts down:", code: "sudo service ssh start" }
const wslForward = (port: number): FixStep => ({
  text: `Windows forwards port ${port} to WSL, or WSL uses mirrored networking. In PowerShell, this lists the forwards:`,
  code: "netsh interface portproxy show v4tov4",
})
const wslFirewall = (port: number): FixStep => ({
  text: `Windows Defender Firewall lets port ${port} in. In an admin PowerShell:`,
  code: `New-NetFirewallRule -DisplayName "SSH ${port}" -Direction Inbound -Protocol TCP -LocalPort ${port} -Action Allow`,
})
const network = (host: string): FixStep => ({
  text: `It's still at ${host} (routers can hand out new addresses), on a network this computer reaches: the same Wi-Fi, a VPN or Tailscale.`,
})

/**
 * What to check on an offline machine, from why Box Yard couldn't reach it. Null when it isn't offline or there's no
 * reason to read (Box Yard shows the problem as it is then).
 */
export function machineFix(m: FixMachine): MachineFix | null {
  if (m.state !== "offline") return null
  const problem = m.problem ?? m.lastTest?.error ?? ""
  if (!problem.trim()) return null
  const detail = sshReason(problem)
  const kind = KINDS.find(([, re]) => re.test(problem))?.[0] ?? "other"
  const { host, port, user } = m
  const wsl = looksLikeWsl(m)
  const mac = /^Darwin/.test(m.lastTest?.os ?? "")
  const command = kind === "hostkey" ? null : sshCommand(m)
  const rechecked = m.lastTest?.ok === true
  const fix = (title: string, steps: FixStep[]): MachineFix => ({ kind, title, detail, steps, command, rechecked })
  switch (kind) {
    case "timeout":
      return fix(`No answer from ${host} on port ${port}`, [
        { text: "It's on and awake, not asleep with its lid closed." },
        network(host),
        ...(wsl ? [wslSshd, wslForward(port), wslFirewall(port)] : [firewall(port)]),
      ])
    case "refused":
      return fix(`${host} answered, but nothing takes SSH on port ${port}`, [
        wsl ? wslSshd : mac ? { text: "Remote Login is on: System Settings › General › Sharing." } : { text: "Its SSH server is running. On Ubuntu or Debian:", code: "sudo systemctl enable --now ssh" },
        { text: `sshd listens on port ${port}. This prints its port:`, code: "sudo sshd -T | grep -i '^port'" },
        ...(wsl ? [wslForward(port)] : []),
      ])
    case "dns":
      return fix(`This computer can't find ${host}`, [
        { text: "The host name is spelled right. Its IP address works too." },
        ...(/\.local$/i.test(host) ? [{ text: ".local names need mDNS on the machine. On Ubuntu or Debian:", code: "sudo apt install -y avahi-daemon" }] : []),
        { text: "This computer is on the machine's network, or your VPN or Tailscale is up." },
      ])
    case "route":
      return fix(`This computer has no way to reach ${host}`, [{ text: "It's on, and on its network." }, network(host), ...(wsl ? [wslFirewall(port)] : [firewall(port)])])
    case "login": {
      const file = keyFile(m.keyRef)
      const copyId = ["ssh-copy-id", file ? `-i ${shellPath(file)}.pub` : null, port === 22 ? null : `-p ${port}`, `${user}@${host}`].filter(Boolean).join(" ")
      return fix(`${host} answered, but turned down the key for ${user}`, [
        { text: `${user} is the right user: agents run as ${user} there.` },
        ...(m.keyRef.startsWith("agent") ? [{ text: "This computer's SSH agent has the key loaded:", code: "ssh-add -l" }] : []),
        { text: `Its public key is in ~/.ssh/authorized_keys for ${user}. From this computer:`, code: copyId },
        { text: "On the machine, ~/.ssh is that user's only:", code: "chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys" },
      ])
    }
    case "hostkey":
      return fix("Its host key changed", [
        { text: "You reinstalled it or changed its SSH server: Forget host key trusts the new key." },
        { text: `You didn't: another computer may be answering at ${host}. Check it before you forget the key.` },
      ])
    case "closed":
      return fix(`${host} hung up before the login finished`, [
        { text: "sshd lets this computer in: fail2ban, or AllowUsers or MaxStartups in its sshd_config, can drop it." },
        { text: `Port ${port} is its SSH server, not another service or a port forward to the wrong place.` },
        ...(wsl ? [wslSshd] : []),
      ])
    case "slow":
      return fix(`${host} connected, but didn't finish in time`, [
        { text: "It isn't asleep or overloaded: a busy laptop can take minutes to answer." },
        { text: "Its login shell doesn't wait for input: a prompt in ~/.bashrc or ~/.profile holds the connection." },
      ])
    case "shell":
      return fix("It logged in, but the test couldn't run", [
        { text: "bash is installed there." },
        { text: "~/.bashrc and ~/.profile don't print or exit when there's no terminal." },
      ])
    default:
      return fix(`Box Yard can't reach ${m.name}`, [{ text: "Run the command below on this computer: ssh says what's wrong." }])
  }
}
