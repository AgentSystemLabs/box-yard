import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { randomUUID } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { setTimeout as sleep } from "node:timers/promises"

interface Holder {
  pid: number
  task: string
  childPid?: number
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

/** Never recursively remove the shared directory: a different waiter may already own it. */
function removeHolder(lockDir: string, name: string) {
  fs.rmSync(path.join(lockDir, name), { force: true })
  try {
    fs.rmdirSync(lockDir)
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
  }
}

/** Exported so subprocess tests can exercise the real lock with a small fake suite. */
export async function runLocked(command: string, args: string[], options: { lockDir?: string; task?: string; pollMs?: number } = {}): Promise<number> {
  const waitingSince = performance.now()
  const lockDir = options.lockDir ?? path.join(os.homedir(), ".boxyard/locks/vitest-full")
  const holder: Holder = { pid: process.pid, task: options.task ?? process.env.BOXYARD_TASK_ID ?? process.cwd().match(/task_[\w-]+/)?.[0] ?? process.cwd() }
  fs.mkdirSync(path.dirname(lockDir), { recursive: true })
  const candidate = fs.mkdtempSync(`${lockDir}-`)
  const name = `owner-${process.pid}-${randomUUID()}.json`
  const updateFile = `${candidate}.json`
  fs.writeFileSync(path.join(candidate, name), JSON.stringify(holder))
  let owned = false
  let child: ChildProcess | undefined
  let signalled: NodeJS.Signals | undefined
  let escalation: NodeJS.Timeout | undefined
  const release = () => {
    // If this wrapper is killed unexpectedly, keep the lock until its suite is dead too.
    if (owned && !(child?.pid && alive(child.pid))) {
      removeHolder(lockDir, name)
      owned = false
    }
    fs.rmSync(candidate, { recursive: true, force: true })
    fs.rmSync(updateFile, { force: true })
  }
  const killSuite = (signal: NodeJS.Signals) => {
    if (!child?.pid) return
    try {
      // Vitest workers belong to the suite's group, not the wrapper's group.
      if (process.platform === "win32") child.kill(signal)
      else process.kill(-child.pid, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
  }
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const
  const handlers = signals.map((signal) => {
    const handler = () => {
      signalled = signal
      if (!child) {
        release()
        process.exit(128 + os.constants.signals[signal])
      }
      killSuite(signal)
      escalation ??= setTimeout(() => killSuite("SIGKILL"), 5000).unref()
    }
    process.on(signal, handler)
    return handler
  })
  process.on("exit", release)
  try {
    let lastWaiting = ""
    while (!owned) {
      try {
        // Both directories have a complete owner file. POSIX rename only replaces an EMPTY directory,
        // so acquisition is atomic without a mkdir→write window, even when several waiters reap a stale owner.
        fs.renameSync(candidate, lockDir)
        owned = true
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
        let entries: string[]
        try {
          entries = fs.readdirSync(lockDir)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
          throw error
        }
        for (const entry of entries) {
          if (!/^owner-\d+-[\w-]+\.json$/.test(entry)) throw new Error(`Unrecognized test lock file: ${path.join(lockDir, entry)}`)
          let current: Holder
          try {
            current = JSON.parse(fs.readFileSync(path.join(lockDir, entry), "utf8")) as Holder
          } catch (error) {
            // Another waiter reaped it, or its owner is recording the just-spawned child.
            if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") continue
            throw error
          }
          if (!alive(current.pid) && !alive(current.childPid ?? 0)) {
            removeHolder(lockDir, entry)
            continue
          }
          const waiting = `${current.task}/pid ${current.pid}${current.childPid ? ` (vitest pid ${current.childPid})` : ""}`
          if (waiting !== lastWaiting) {
            console.log(`waiting for ${waiting}`)
            lastWaiting = waiting
          }
        }
        await sleep(options.pollMs ?? 1000)
      }
    }
    const acquiredAt = performance.now()
    console.log(`full vitest lock acquired by ${holder.task}/pid ${holder.pid}; lock wait ${((acquiredAt - waitingSince) / 1000).toFixed(3)}s`)
    child = spawn(command, args, { stdio: "inherit", detached: process.platform !== "win32" })
    if (child.pid) {
      holder.childPid = child.pid
      fs.writeFileSync(updateFile, JSON.stringify(holder))
      fs.renameSync(updateFile, path.join(lockDir, name))
    }
    const code = await new Promise<number>((resolve, reject) => {
      child!.once("error", reject)
      child!.once("close", (code, signal) => {
        child = undefined
        const endedBy = signalled ?? signal
        resolve(endedBy ? 128 + os.constants.signals[endedBy] : code ?? 1)
      })
    })
    console.log(`vitest finished: exit ${code}; execution ${((performance.now() - acquiredAt) / 1000).toFixed(3)}s (excludes lock wait)`)
    return code
  } finally {
    if (escalation) clearTimeout(escalation)
    signals.forEach((signal, i) => process.off(signal, handlers[i]!))
    process.off("exit", release)
    release()
  }
}
