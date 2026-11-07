import { get, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import { gunzipSync } from "node:zlib"
import express from "express"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { MAX_RECENT_CAPTAIN_MESSAGES, MAX_RECENT_CAPTAINS, RECENT_CAPTAIN_MESSAGES, recentCaptains, recentLimit, sendCompressedJson, type RecentCaptainSources } from "../server/captainRecent.js"
import type { CaptainMessage, CaptainState, Project } from "../shared/types.js"

const state = (projectId: string): CaptainState => ({
  projectId, busy: false, usage: { tokens: null, window: null, updatedAt: null }, compacting: false, compactQueued: false, lastCompaction: null, compactionsDir: "", error: null,
})
const messages = (projectId: string, n: number): CaptainMessage[] =>
  Array.from({ length: n }, (_, i) => ({ id: `cap_${projectId}_${i}`, projectId, role: "assistant", content: `reply ${i}`, meta: null, createdAt: i }))

/** Sources over fixed transcripts; `messages` returns the newest `limit`, oldest first, as CaptainManager.messages does. */
function sources(transcripts: Record<string, number>): RecentCaptainSources & { asked: number[] } {
  const asked: number[] = []
  return {
    asked,
    projects: () => Object.keys(transcripts).map((id) => ({ id, name: id }) as Project),
    state,
    messages: (id, limit) => (asked.push(limit), messages(id, transcripts[id]!).slice(-limit)),
    threads: () => [],
  }
}

describe("recentCaptains", () => {
  it("gives every project's Captain its newest messages, saying whether older ones exist", () => {
    const src = sources({ prj_a: 3, prj_b: 5, prj_c: 0 })
    const out = recentCaptains(src, 3)
    expect(out.map((r) => [r.projectId, r.messages.length, r.more])).toEqual([["prj_a", 3, false], ["prj_b", 3, true], ["prj_c", 0, false]])
    // The newest, oldest first, as the chat shows them.
    expect(out[1]!.messages.map((m) => m.content)).toEqual(["reply 2", "reply 3", "reply 4"])
    expect(out[1]!.state).toEqual(state("prj_b"))
    expect(out[1]!.threads).toEqual([])
    expect(src.asked).toEqual([4, 4, 4])
  })

  it("defaults to more than the chat's first screen, and bounds the projects in one response", () => {
    const many = Object.fromEntries(Array.from({ length: MAX_RECENT_CAPTAINS + 5 }, (_, i) => [`prj_${i}`, 1]))
    const src = sources(many)
    const out = recentCaptains(src)
    expect(out).toHaveLength(MAX_RECENT_CAPTAINS)
    expect(src.asked[0]).toBe(RECENT_CAPTAIN_MESSAGES + 1)
    expect(RECENT_CAPTAIN_MESSAGES).toBeGreaterThan(60) // useTail's first screen
  })
})

describe("recentLimit", () => {
  it("reads ?limit= within bounds", () => {
    expect(recentLimit(undefined)).toBe(RECENT_CAPTAIN_MESSAGES)
    expect(recentLimit("20")).toBe(20)
    expect(recentLimit("0")).toBe(RECENT_CAPTAIN_MESSAGES)
    expect(recentLimit("-4")).toBe(RECENT_CAPTAIN_MESSAGES)
    expect(recentLimit("lots")).toBe(RECENT_CAPTAIN_MESSAGES)
    expect(recentLimit(["5"])).toBe(RECENT_CAPTAIN_MESSAGES)
    expect(recentLimit("100000")).toBe(MAX_RECENT_CAPTAIN_MESSAGES)
  })
})

describe("sendCompressedJson", () => {
  let base = ""
  let close = () => {}
  const big = { text: "the Captain said ".repeat(500) }
  beforeAll(async () => {
    const app = express()
    app.get("/big", (req, res) => sendCompressedJson(req, res, big))
    app.get("/small", (req, res) => sendCompressedJson(req, res, { ok: true }))
    const server = app.listen(0, "127.0.0.1")
    await new Promise((r) => server.once("listening", r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    close = () => server.close()
  })
  afterAll(() => close())

  const fetchRaw = (path: string, encoding?: string) =>
    new Promise<{ res: IncomingMessage; body: Buffer }>((resolve, reject) =>
      get(`${base}${path}`, { headers: encoding ? { "Accept-Encoding": encoding } : {} }, (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c: Buffer) => chunks.push(c))
        res.on("end", () => resolve({ res, body: Buffer.concat(chunks) }))
      }).on("error", reject),
    )

  it("gzips a large body for a browser that takes gzip", async () => {
    const { res, body } = await fetchRaw("/big", "gzip, deflate, br")
    expect(res.headers["content-encoding"]).toBe("gzip")
    expect(res.headers["content-type"]).toMatch(/application\/json/)
    expect(res.headers.vary).toMatch(/Accept-Encoding/i)
    expect(body.length).toBeLessThan(JSON.stringify(big).length / 5)
    expect(JSON.parse(gunzipSync(body).toString())).toEqual(big)
  })

  it("sends plain JSON to a client without gzip, and for a small body", async () => {
    const plain = await fetchRaw("/big")
    expect(plain.res.headers["content-encoding"]).toBeUndefined()
    expect(JSON.parse(plain.body.toString())).toEqual(big)
    const small = await fetchRaw("/small", "gzip")
    expect(small.res.headers["content-encoding"]).toBeUndefined()
    expect(JSON.parse(small.body.toString())).toEqual({ ok: true })
  })
})
