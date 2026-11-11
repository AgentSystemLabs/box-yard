// /api/update and its actions on a real server (server/app.ts): a server the launcher didn't start says so (409 with
// how to update a checkout), and one it did relays Check, Update and Restart now over the launcher's channel and
// streams the launcher's status as "update" events.
import { EventEmitter } from "node:events"
import type { Server } from "node:http"
import { afterEach, expect, it, vi } from "vitest"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { STATUS_MESSAGE } from "../server/selfUpdate.js"
import { UNMANAGED_UPDATE } from "../shared/selfUpdate.js"
import type { UiEvent } from "../shared/types.js"
import { freePort, testConfig, tmpDir } from "./helpers.js"

const A = "a".repeat(40)
const B = "b".repeat(40)

let yard: BoxYard | undefined
let server: Server | undefined
afterEach(async () => {
  yard?.stop()
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  yard = undefined
  server = undefined
})

class FakeLauncher extends EventEmitter {
  connected = true
  sent: unknown[] = []
  send(msg: unknown) {
    this.sent.push(msg)
    return true
  }
}

async function start(updateChannel: FakeLauncher | null) {
  const port = await freePort()
  yard = createBoxYard(testConfig({ port }), { webDir: "/nonexistent", machines: { keys: { home: tmpDir() } }, updateChannel })
  server = await new Promise<Server>((resolve) => {
    const s = yard!.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  return `http://127.0.0.1:${port}/api/update`
}

it("says a server the launcher didn't start can't update itself", async () => {
  const url = await start(null)
  expect(await (await fetch(url)).json()).toEqual(UNMANAGED_UPDATE)
  for (const action of ["check", "start", "restart"]) {
    const res = await fetch(`${url}/${action}`, { method: "POST" })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/wasn't started with npx.*git pull, then \.\/yard local/)
  }
})

it("relays the buttons to the launcher and streams its status", async () => {
  const launcher = new FakeLauncher()
  const url = await start(launcher)
  const broadcast = vi.spyOn(yard!.hub, "broadcast")
  const events = () => broadcast.mock.calls.map(([ev]) => ev as UiEvent)
  expect(launcher.sent).toEqual([{ type: "box-yard:update", action: "hello" }])

  launcher.emit("message", { type: STATUS_MESSAGE, status: { ...UNMANAGED_UPDATE, managed: undefined, current: A, latest: B, checkedAt: 1 } })
  expect(await (await fetch(url)).json()).toMatchObject({ managed: true, current: A, latest: B, phase: "idle" })
  expect(events().filter((e) => e.type === "update").at(-1)).toMatchObject({ type: "update", status: { managed: true, latest: B } })

  expect((await fetch(`${url}/check`, { method: "POST" })).status).toBe(200)
  expect((await fetch(`${url}/start`, { method: "POST" })).status).toBe(200)
  expect(launcher.sent.map((m) => (m as { action: string }).action)).toEqual(["hello", "check", "start"])

  // Built while nothing is mid-reply: it restarts into it at once.
  launcher.emit("message", { type: STATUS_MESSAGE, status: { ...UNMANAGED_UPDATE, current: A, latest: B, phase: "ready", ready: B } })
  expect(launcher.sent.at(-1)).toEqual({ type: "box-yard:update", action: "apply" })
})
