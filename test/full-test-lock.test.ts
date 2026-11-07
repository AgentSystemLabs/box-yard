import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { tmpDir, waitFor } from "./helpers.js"

const children: ChildProcess[] = []
const suitePids: number[] = []
afterEach(async () => {
  // Let wrappers forward the signal to their suites, so a failed assertion cannot leave a fake suite behind.
  await Promise.all(children.splice(0).map((child) => {
    if (child.exitCode !== null || child.signalCode !== null) return
    return new Promise<void>((resolve) => {
      child.once("exit", () => resolve())
      child.kill("SIGTERM")
    })
  }))
  for (const pid of suitePids.splice(0)) {
    try { process.kill(-pid, "SIGKILL") } catch {}
  }
})

function fixture() {
  const dir = tmpDir("boxyard-test-lock-")
  const lockDir = path.join(dir, "locks/vitest-full")
  const suite = path.join(dir, "suite.mjs")
  fs.writeFileSync(suite, `
    import fs from 'node:fs';
    const [dir, name, code] = process.argv.slice(2);
    fs.writeFileSync(dir + '/active', name, { flag: 'wx' });
    fs.writeFileSync(dir + '/' + name + '.started', String(process.pid));
    const timer = setInterval(() => {
      if (fs.existsSync(dir + '/' + name + '.end')) {
        clearInterval(timer);
        fs.unlinkSync(dir + '/active');
        process.exit(Number(code));
      }
    }, 20);
    process.on('SIGINT', () => { fs.rmSync(dir + '/active', { force: true }); process.exit(130) });
    process.on('SIGTERM', () => { fs.rmSync(dir + '/active', { force: true }); process.exit(143) });
  `)
  function run(name: string, code = 0, command = process.execPath) {
    const script = `import { runLocked } from ${JSON.stringify(path.resolve("scripts/testLock.ts"))};
      process.exitCode = await runLocked(${JSON.stringify(command)}, ${JSON.stringify([suite, dir, name, String(code)])}, ${JSON.stringify({ lockDir, task: name, pollMs: 20 })});`
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] })
    children.push(child)
    let output = ""
    child.stdout.on("data", (data) => { output += data })
    child.stderr.on("data", (data) => { output += data })
    const ended = new Promise<number | null>((resolve) => child.once("exit", resolve))
    const started = async () => {
      const pid = await waitFor(() => fs.existsSync(path.join(dir, `${name}.started`)) && Number(fs.readFileSync(path.join(dir, `${name}.started`), "utf8")), `${name} started`)
      suitePids.push(pid)
      return pid
    }
    return { child, ended, started, output: () => output, end: () => fs.writeFileSync(path.join(dir, `${name}.end`), "ok") }
  }
  return { dir, lockDir, run }
}

describe("machine-wide full-suite lock", () => {
  it("serializes simultaneous suites and prints the current task/pid while waiting", async () => {
    const f = fixture()
    const first = f.run("task_first")
    await first.started()
    const waiters = [f.run("task_second"), f.run("task_third"), f.run("task_fourth")]
    for (const waiter of waiters) await waitFor(() => waiter.output().includes(`waiting for task_first/pid ${first.child.pid}`), "waiting output")
    expect(fs.readFileSync(path.join(f.dir, "active"), "utf8")).toBe("task_first")
    for (const run of [first, ...waiters]) run.end()
    expect(await first.ended).toBe(0)
    expect(await Promise.all(waiters.map((w) => w.ended))).toEqual([0, 0, 0])
    expect(fs.existsSync(f.lockDir)).toBe(false)
  })

  it("releases on failure and preserves the suite's exit code", async () => {
    const f = fixture()
    const run = f.run("task_failed", 7)
    await run.started()
    run.end()
    expect(await run.ended).toBe(7)
    expect(fs.existsSync(f.lockDir)).toBe(false)
  })

  it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)("releases on %s, including while waiting", async (signal) => {
    const f = fixture()
    const run = f.run("task_holder")
    await run.started()
    const waiting = f.run("task_waiter")
    await waitFor(() => waiting.output().includes("waiting for task_holder"), "waiter")
    waiting.child.kill(signal)
    await waiting.ended
    expect(fs.existsSync(f.lockDir)).toBe(true)
    run.child.kill(signal)
    await run.ended
    expect(fs.existsSync(f.lockDir)).toBe(false)
  })

  it("keeps an orphaned suite locked, then lets competing waiters reclaim its dead owner", async () => {
    const f = fixture()
    const run = f.run("task_orphan")
    const pid = await run.started()
    run.child.kill("SIGKILL")
    await run.ended
    const next = f.run("task_next")
    await waitFor(() => next.output().includes("waiting for task_orphan"), "orphan keeps lock")
    expect(fs.readFileSync(path.join(f.dir, "active"), "utf8")).toBe("task_orphan")
    process.kill(-pid, "SIGKILL")
    fs.rmSync(path.join(f.dir, "active"), { force: true })
    const other = f.run("task_other")
    next.end()
    other.end()
    expect(await next.ended).toBe(0)
    expect(await other.ended).toBe(0)
    expect(fs.existsSync(f.lockDir)).toBe(false)
  })

  it("releases if the suite executable cannot start", async () => {
    const f = fixture()
    const run = f.run("task_bad_command", 0, path.join(f.dir, "missing-command"))
    expect(await run.ended).not.toBe(0)
    expect(fs.existsSync(f.lockDir)).toBe(false)
  })
})
