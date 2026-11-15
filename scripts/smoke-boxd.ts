/**
 * Smoke test the boxd provider against the real API, using BOXD_API_KEY from the env or .env
 * (docs/boxd.md). Spends money: one 1 vCPU machine (about $0.047/hr) for a few minutes, deleted
 * at the end. Machines are named byard-smoke-<n> so earlier leftovers can be swept.
 *
 *   npx tsx scripts/smoke-boxd.ts          # start a machine, check everything, delete it
 *   npx tsx scripts/smoke-boxd.ts --keep   # leave the machine up and print its id
 *
 * Checks: the key lists machines, a machine of the yard's small size starts ready with node, git,
 * Claude Code and Codex already installed, commands run in a login shell, file write/read, streamed
 * output with stderr apart, a command longer than two minutes, a detached process outliving the
 * command that started it, a pause/wake round trip, a snapshot a new machine restores from, a server
 * reachable on the port's proxy URL, and the delete.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { config } from "../server/config.js"
import { BoxdProvider } from "../server/providers/boxd.js"
import { Boxd } from "@boxd-sh/sdk"

const keep = process.argv.includes("--keep")
if (!config.boxdApiKey) throw new Error("BOXD_API_KEY is not set")
const p = new BoxdProvider(config)
const raw = new Boxd({ apiKey: config.boxdApiKey })
const results: { name: string; ok: boolean }[] = []

async function check(name: string, fn: () => Promise<string>) {
  const t = Date.now()
  try {
    const detail = await fn()
    results.push({ name, ok: true })
    console.log(`✓ ${name} (${Date.now() - t}ms) ${detail}`)
  } catch (err) {
    results.push({ name, ok: false })
    console.log(`✗ ${name} (${Date.now() - t}ms) ${String((err as Error).message ?? err).slice(0, 800)}`)
  }
}

async function sh(cmd: string) {
  const r = await p.exec(box, cmd)
  if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}: ${(r.stderr || r.stdout).slice(-600)}`)
  return r.stdout.trim()
}

const snapName = `byard-smoke-${randomUUID().slice(0, 8)}`
const name = `byard-smoke-${randomUUID().slice(0, 8)}`
let box = ""

try {
  box = await p.create({ labels: ["smoke"] })
  await check("key", async () => {
    const live = (await raw.machines.list()).filter((m) => m.name.startsWith("byard-") && m.status !== "destroyed")
    return `lists machines (${live.length} byard one${live.length === 1 ? "" : "s"} on the account)`
  })
  await check("machine starts ready", async () => {
    await raw.machines.waitUntilReady(box)
    return `${box} at 1 vCPU / 4 GiB with node, git, claude and codex built in`
  })
  await check("tools in a login shell", () => sh("node --version && git --version && claude --version | head -1 && codex --version | head -1"))
  await check("file write/read", async () => {
    await p.writeFile(box, "/home/boxd/yard/smoke/x.txt", "hello")
    const back = (await p.readFile(box, "/home/boxd/yard/smoke/x.txt")).toString("utf8")
    if (back !== "hello") throw new Error(`read back ${JSON.stringify(back)}`)
    return "ok"
  })
  await check("64 MB upload", async () => {
    // Workspace archives go up this way: a limit in the SDK's chunked upload would show here.
    const local = path.join(os.tmpdir(), `box-yard-boxd-smoke-${process.pid}.bin`)
    const data = randomBytes(64 * 1024 * 1024)
    fs.writeFileSync(local, data)
    try {
      await p.uploadFile(box, local, "/home/boxd/yard/smoke/big.bin")
    } finally {
      fs.rmSync(local, { force: true })
    }
    const want = createHash("sha256").update(data).digest("hex")
    const got = (await sh("sha256sum /home/boxd/yard/smoke/big.bin")).split(/\s/)[0]
    if (got !== want) throw new Error(`sha256 ${got}, expected ${want}`)
    return "sha256 matches"
  })
  await check("streamed output, stderr apart", async () => {
    let out = ""
    const r = await p.execStream(box, "seq 1 200000; echo oops >&2", (chunk) => (out += chunk))
    const lines = out.trim().split("\n")
    if (r.exitCode !== 0 || lines.length !== 200001 || lines.at(-1) !== "oops") throw new Error(`exit ${r.exitCode}, ${lines.length} lines, last ${JSON.stringify(lines.at(-1))}`)
    return `${out.length} bytes, stderr on the same wire`
  })
  await check("command longer than two minutes", async () => {
    // A turn's hold and long installs keep one call open for minutes: a proxy that cuts idle calls shows here.
    const out = await sh("sleep 130 && echo done")
    if (out !== "done") throw new Error(`printed ${JSON.stringify(out)}`)
    return "done"
  })
  await check("detached process survives", async () => {
    await sh("(setsid nohup sleep 600 > /dev/null 2>&1 &) && echo started")
    await new Promise((r) => setTimeout(r, 3000))
    return `pid ${await sh("pgrep -x sleep | head -1")}`
  })
  await check("pause and wake", async () => {
    // Pause is asynchronous: poll until the status actually flips, then the same for the wake.
    const until = async (want: string) => {
      for (let i = 0; i < 10; i++) {
        if ((await p.health(box)) === want) return true
        await new Promise((r) => setTimeout(r, 1500))
      }
      return (await p.health(box)) === want
    }
    await raw.machines.pause(box)
    if (!(await until("paused"))) throw new Error(`health after pause: ${await p.health(box)}`)
    await p.wake(box)
    if (!(await until("running"))) throw new Error(`health after wake: ${await p.health(box)}`)
    return "standby and back, as the idle sweep will find it"
  })
  await check("snapshot restores", async () => {
    await p.writeFile(box, "/home/boxd/yard/smoke/snap.txt", "carried over")
    const snap = await p.snapshot(box, snapName)
    const second = await p.create({ labels: ["smoke"], snapshotId: snap.id })
    try {
      const back = (await p.readFile(second, "/home/boxd/yard/smoke/snap.txt")).toString("utf8")
      if (back !== "carried over") throw new Error(`restored ${JSON.stringify(back)}`)
      return `snapshot ${snap.id} (${snap.bytes} bytes) carried the files`
    } finally {
      await p.destroy(second)
    }
  })
  await check("proxy URL serves a file", async () => {
    const port = 3000
    await sh(`cd /home/boxd/yard/smoke && (nohup python3 -m http.server ${port} --bind 0.0.0.0 > http.log 2>&1 &) && sleep 1`)
    const url = await p.publicUrl(box, port)
    const again = await p.publicUrl(box, port) // idempotent: the second call reuses the proxy
    if (again !== url) throw new Error(`second publicUrl gave ${again}, first ${url}`)
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${url}/x.txt`).catch(() => null)
      if (res?.ok && (await res.text()) === "hello") return url
      await new Promise((r) => setTimeout(r, 3000))
    }
    throw new Error(`${url} never served the file`)
  })
} finally {
  if (keep) {
    console.log(`\nKept the machine: ${box}. Delete it in the boxd console or with: boxd machine remove ${name}`)
  } else {
    if (box) await p.destroy(box).catch((e) => console.log(`✗ delete: ${(e as Error).message}. Delete it in the boxd console.`))
    if (snapName) await p.deleteSnapshot(snapName).catch(() => {})
    // Any other smoke machine (a start that failed half way) goes too.
    for (const m of await raw.machines.list().catch(() => [])) {
      if (m.name.startsWith("byard-smoke-") && m.status !== "destroyed") {
        await p.destroy(m.id).catch((e) => console.log(`✗ delete ${m.id}: ${(e as Error).message}`))
      }
    }
  }
  await raw.close().catch(() => {})
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length ? 1 : 0)
}
