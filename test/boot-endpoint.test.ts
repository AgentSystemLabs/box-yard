import type { Server } from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { BOOT_PATHS, captainStatePath, isBootPath, type BootPayload, type StreamPosition } from "../shared/boot.js"
import { freePort, testConfig } from "./helpers.js"

// GET /api/boot answers each path exactly as its own GET does, with the stream position the web app lines events up by.

const running: { yard: BoxYard; server: Server }[] = []

async function start(password = "") {
  const port = await freePort()
  const yard = createBoxYard(testConfig({ port, password }), { webDir: "/nonexistent" })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  running.push({ yard, server })
  return { yard, base: `http://127.0.0.1:${port}` }
}

afterEach(async () => {
  for (const r of running.splice(0)) {
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

const getJson = async (url: string) => {
  const res = await fetch(url)
  expect(res.status).toBe(200)
  return res.json()
}

/** An open /api/stream: `until` reads on until what it has heard so far passes `done`. */
async function openStream(base: string, path = "/api/stream") {
  const abort = new AbortController()
  const res = await fetch(`${base}${path}`, { signal: abort.signal })
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ""
  const until = async (done: (text: string) => boolean) => {
    while (!done(text)) {
      const { value, done: ended } = await reader.read()
      if (ended) break
      text += decoder.decode(value)
    }
    return text
  }
  return { until, close: () => abort.abort() }
}

/** Where a hello says its stream starts (it also names the web build, which test/app-update.test.ts checks). */
const helloOf = (text: string): StreamPosition => {
  const hello = /event: hello\ndata: (.+)\n\n/.exec(text)
  expect(hello).not.toBeNull()
  const { epoch, seq } = JSON.parse(hello![1]!) as StreamPosition
  return { epoch, seq }
}

describe("GET /api/boot", () => {
  it("answers every boot path, and each project's Captain state, as its own GET would", async () => {
    const { yard, base } = await start()
    const a = yard.store.createProject({ name: "alpha", repo: "acme/alpha" })
    const b = yard.store.createProject({ name: "beta", repo: "acme/beta" })
    yard.store.createTask({ projectId: a.id, title: "first", prompt: "do it" })
    yard.store.createTask({ projectId: b.id, title: "second", prompt: "do that" })
    yard.store.addChat("user", "hello")
    yard.store.addChat("assistant", "hi")

    const res = await fetch(`${base}/api/boot`, { headers: { "Accept-Encoding": "gzip" } })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-encoding")).toBe("gzip")
    const boot = (await res.json()) as BootPayload

    const paths = [...BOOT_PATHS, captainStatePath(a.id), captainStatePath(b.id)]
    expect(Object.keys(boot.responses).sort()).toEqual([...paths].sort())
    for (const path of paths) {
      expect(isBootPath(path)).toBe(true)
      const own = await getJson(`${base}${path}`)
      expect(boot.responses[path], path).toEqual(own)
    }
    expect((boot.responses["/api/tasks"] as unknown[]).length).toBe(2)
    expect((boot.responses["/api/chat"] as unknown[]).length).toBe(2)
  })

  it("says where the stream stood, and a stream opens with a hello saying where it starts", async () => {
    const { yard, base } = await start()
    const before = ((await getJson(`${base}/api/boot`)) as BootPayload).stream
    expect(before).toEqual(yard.hub.position())

    yard.hub.broadcast({ type: "chat.stream", content: "one" } as never)
    yard.hub.broadcast({ type: "chat.stream", content: "two" } as never)
    const after = ((await getJson(`${base}/api/boot`)) as BootPayload).stream
    expect(after).toEqual({ epoch: before.epoch, seq: before.seq + 2 })

    const stream = await openStream(base)
    expect(helloOf(await stream.until((t) => t.includes("event: hello")))).toEqual(after)
    stream.close()
  })

  it("counts each broadcast once, after the stream's hello", async () => {
    const { yard, base } = await start()
    const stream = await openStream(base)
    const hello = helloOf(await stream.until((t) => t.includes("event: hello")))
    expect(hello).toEqual(yard.hub.position())
    for (const content of ["a", "b", "c"]) yard.hub.broadcast({ type: "chat.stream", content } as never)
    const text = await stream.until((t) => t.includes('"content":"c"'))
    stream.close()
    expect(yard.hub.position().seq).toBe(hello.seq + 3)
    // The hello comes before any event: the app counts the events after it.
    expect([...text.matchAll(/"content":"(\w)"/g)].map((m) => m[1])).toEqual(["a", "b", "c"])
    expect(text.indexOf("event: hello")).toBeLessThan(text.indexOf('"content":"a"'))
  })

  it("marks where it was read in every open stream, a patch stream that heard less too", async () => {
    const { yard, base } = await start()
    const p = yard.store.createProject({ name: "alpha", repo: "acme/alpha" })
    const task = yard.store.createTask({ projectId: p.id, title: "first", prompt: "do it" })
    const stream = await openStream(base, "/api/stream?patches=1")
    const hello = helloOf(await stream.until((t) => t.includes("event: hello")))
    yard.hub.broadcast({ type: "task", task })
    // Nothing changed: the patch stream hears nothing of this one.
    yard.hub.broadcast({ type: "task", task })
    const boot = (await getJson(`${base}/api/boot`)) as BootPayload
    yard.hub.broadcast({ type: "chat.stream", content: "after" } as never)
    const text = await stream.until((t) => t.includes('"content":"after"'))
    stream.close()

    expect(boot.stream).toEqual({ epoch: hello.epoch, seq: hello.seq + 2 })
    const frames = text.slice(text.indexOf("event: hello")).split("\n\n").filter(Boolean)
    expect(frames.map((f) => (f.startsWith("event: ") ? f.slice(7, f.indexOf("\n")) : (JSON.parse(f.slice(6)) as { type: string }).type))).toEqual([
      "hello",
      "task",
      "boot",
      "chat.stream",
    ])
    expect(JSON.parse(frames[2]!.split("\ndata: ")[1]!)).toEqual(boot.stream)
  })

  it("is signed in only, like the GETs it answers", async () => {
    const { base } = await start("lantern-gravel-quokka-sonnet")
    expect((await fetch(`${base}/api/boot`)).status).toBe(401)
  })
})
