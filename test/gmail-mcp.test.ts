import { afterEach, describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import http from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

// Box Yard's Gmail server (runner/gmail-mcp.mjs) against a fake Gmail API: the tools it has (no send), what they read
// and write, and that it takes only its access token.

const GMAIL_MCP = path.resolve("runner/gmail-mcp.mjs")
const TOKEN = "ya29.fake-gmail-access-token"

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url")

const MESSAGES: Record<string, Record<string, unknown>> = {
  m1: {
    id: "m1",
    threadId: "t1",
    labelIds: ["INBOX", "UNREAD"],
    snippet: "The invoice for October",
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: "Ana <ana@example.com>" },
        { name: "To", value: "me@example.com" },
        { name: "Subject", value: "Invoice" },
        { name: "Date", value: "Mon, 2 Nov 2026 09:00:00 +0000" },
        { name: "Message-ID", value: "<m1@example.com>" },
      ],
      parts: [
        { mimeType: "text/plain", body: { data: b64("Hi,\nthe invoice is attached.\nAna") } },
        { mimeType: "application/pdf", filename: "invoice.pdf", body: { attachmentId: "a1", size: 1234 } },
      ],
    },
  },
  m2: {
    id: "m2",
    threadId: "t1",
    labelIds: ["INBOX"],
    snippet: "Thanks",
    payload: {
      mimeType: "text/html",
      headers: [
        { name: "From", value: "me@example.com" },
        { name: "Subject", value: "Re: Invoice" },
      ],
      body: { data: b64("<p>Thanks &amp; regards</p><script>x()</script>") },
    },
  },
}

/** A fake Gmail API on this computer: it checks the token and keeps the drafts it gets. */
async function fakeGmail() {
  const drafts: { raw: string; threadId?: string }[] = []
  const seen: string[] = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x")
    seen.push(`${req.method} ${url.pathname}`)
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" })
      res.end(JSON.stringify(body))
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: { message: "Invalid Credentials" } })
    const p = url.pathname.replace(/^\/gmail\/v1\/users\/me/, "")
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      if (p === "/messages" && req.method === "GET") return send(200, { messages: [{ id: "m1" }, { id: "m2" }], resultSizeEstimate: 2, nextPageToken: url.searchParams.get("q") === "invoice" ? "next" : undefined })
      const m = p.match(/^\/messages\/([^/]+)$/)
      if (m && MESSAGES[m[1]]) return send(200, MESSAGES[m[1]])
      if (p === "/threads/t1") return send(200, { id: "t1", messages: [MESSAGES.m1, MESSAGES.m2] })
      if (p === "/labels") return send(200, { labels: [{ id: "INBOX", name: "INBOX", type: "system" }, { id: "Label_1", name: "Receipts", type: "user" }] })
      if (p === "/profile") return send(200, { emailAddress: "me@example.com", messagesTotal: 42, threadsTotal: 30 })
      if (p === "/drafts" && req.method === "POST") {
        const body = JSON.parse(raw) as { message: { raw: string; threadId?: string } }
        drafts.push(body.message)
        return send(200, { id: "d1", message: { id: "dm1", threadId: body.message.threadId ?? "t9" } })
      }
      send(404, { error: { message: `no ${p}` } })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { base, drafts, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f()
})

async function connect(env: Record<string, string>) {
  const client = new Client({ name: "test", version: "0" })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [GMAIL_MCP], env: { PATH: process.env.PATH ?? "", ...env }, stderr: "ignore" }))
  cleanups.push(() => client.close())
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] }
    return { error: r.isError === true, text: r.content[0]?.text ?? "", json: () => JSON.parse(r.content[0]?.text ?? "null") }
  }
  return { client, call }
}

describe("Box Yard's Gmail server", () => {
  it("has read tools and drafts, and no tool that sends, deletes or relabels", async () => {
    const api = await fakeGmail()
    cleanups.push(api.close)
    const { client } = await connect({ GOOGLE_ACCESS_TOKEN: TOKEN, GMAIL_API_BASE: api.base })
    const tools = (await client.listTools()).tools
    expect(tools.map((t) => t.name).sort()).toEqual(["create_draft", "get_profile", "list_labels", "read_message", "read_thread", "search_messages"])
    expect(tools.filter((t) => /send|delete|trash|modify|label_add|remove/i.test(t.name))).toEqual([])
    for (const t of tools.filter((x) => x.name !== "create_draft")) expect(t.annotations?.readOnlyHint, t.name).toBe(true)
  })

  it("searches, reads a message and a thread, lists labels and names the mailbox", async () => {
    const api = await fakeGmail()
    cleanups.push(api.close)
    const { call } = await connect({ GOOGLE_ACCESS_TOKEN: TOKEN, GMAIL_API_BASE: api.base })

    const found = (await call("search_messages", { query: "invoice", max_results: 5 })).json()
    expect(found.messages.map((m: { id: string }) => m.id)).toEqual(["m1", "m2"])
    expect(found.messages[0]).toMatchObject({ threadId: "t1", from: "Ana <ana@example.com>", subject: "Invoice", snippet: "The invoice for October" })
    expect(found.nextPageToken).toBe("next")

    const m1 = (await call("read_message", { id: "m1" })).json()
    expect(m1.body).toBe("Hi,\nthe invoice is attached.\nAna")
    expect(m1.attachments).toEqual([{ filename: "invoice.pdf", mimeType: "application/pdf", size: 1234 }])
    // An HTML-only message reads as text, its scripts gone.
    const m2 = (await call("read_message", { id: "m2" })).json()
    expect(m2.body).toBe("Thanks & regards")

    const thread = (await call("read_thread", { id: "t1" })).json()
    expect(thread.messages.map((m: { subject: string }) => m.subject)).toEqual(["Invoice", "Re: Invoice"])
    expect((await call("list_labels")).json().labels).toContainEqual({ id: "Label_1", name: "Receipts", type: "user" })
    expect((await call("get_profile")).json()).toEqual({ emailAddress: "me@example.com", messagesTotal: 42, threadsTotal: 30 })
    // Only reads went to the API.
    expect(api.seen.filter((s) => !s.startsWith("GET "))).toEqual([])
  })

  it("writes a draft (a reply joins its thread) and never sends it; a header can't be smuggled in", async () => {
    const api = await fakeGmail()
    cleanups.push(api.close)
    const { call } = await connect({ GOOGLE_ACCESS_TOKEN: TOKEN, GMAIL_API_BASE: api.base })

    const r = (await call("create_draft", { to: "ana@example.com\r\nBcc: spy@example.com", body: "Thank you, paid. — Zoë", reply_to_message_id: "m1" })).json()
    expect(r).toMatchObject({ draftId: "d1", threadId: "t1" })
    expect(api.drafts).toHaveLength(1)
    expect(api.drafts[0].threadId).toBe("t1")
    const mime = Buffer.from(api.drafts[0].raw, "base64url").toString("utf8")
    const [head, body] = mime.split("\r\n\r\n")
    expect(head.split("\r\n")).toEqual(expect.arrayContaining(["To: ana@example.com Bcc: spy@example.com", "Subject: Re: Invoice", "In-Reply-To: <m1@example.com>", "References: <m1@example.com>"]))
    expect(head).not.toMatch(/^Bcc:/m)
    expect(Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8")).toBe("Thank you, paid. — Zoë")
    // A non-ASCII subject is an encoded word.
    await call("create_draft", { to: "a@example.com", subject: "Grüße", body: "x" })
    expect(Buffer.from(api.drafts[1].raw, "base64url").toString("utf8")).toContain(`Subject: =?UTF-8?B?${Buffer.from("Grüße").toString("base64")}?=`)
    // Drafts only: nothing went to send.
    expect(api.seen.filter((s) => /send/.test(s))).toEqual([])
  })

  it("says to sign in again when Google turns the token down, or when it has none", async () => {
    const api = await fakeGmail()
    cleanups.push(api.close)
    const stale = await connect({ GOOGLE_ACCESS_TOKEN: "ya29.expired", GMAIL_API_BASE: api.base })
    const r = await stale.call("search_messages", { query: "" })
    expect(r.error).toBe(true)
    expect(r.text).toMatch(/401.*sign in to Gmail again/)
    const none = await connect({ GMAIL_API_BASE: api.base })
    expect((await none.call("get_profile")).text).toMatch(/Not signed in/)
  })

  it("won't send its token to plain http on another computer", () => {
    const r = spawnSync(process.execPath, [GMAIL_MCP], { env: { PATH: process.env.PATH, GOOGLE_ACCESS_TOKEN: TOKEN, GMAIL_API_BASE: "http://evil.example" }, input: "", encoding: "utf8", timeout: 10_000 })
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/must be https/)
  })
})
