#!/usr/bin/env node
// Box Yard's Gmail connector (docs/connectors.md › Gmail): a small stdio MCP server that reads mail and writes drafts
// through the Gmail API. It gets only a Google access token, in GOOGLE_ACCESS_TOKEN: Box Yard keeps the refresh token
// and the OAuth client on its server and hands each session a token that lasts it. There is no send tool: a draft
// waits in Gmail for its owner to read and send.
//
//   GOOGLE_ACCESS_TOKEN   the access token (gmail.readonly + gmail.compose)
//   GMAIL_API_BASE        the API's address, for tests (https, or http to this computer only)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

const BASE = (process.env.GMAIL_API_BASE || "https://gmail.googleapis.com").replace(/\/+$/, "")
{
  const u = new URL(BASE)
  if (u.protocol !== "https:" && !(u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname))) {
    process.stderr.write("gmail-mcp: GMAIL_API_BASE must be https (or http to this computer)\n")
    process.exit(2)
  }
}
const API = `${BASE}/gmail/v1/users/me`
/** A message body longer than this is cut, with a note: a whole newsletter would fill the context. */
const MAX_BODY = 20_000
const MAX_RESULTS = 50

class GmailError extends Error {}

async function gmail(path, init = {}) {
  const token = process.env.GOOGLE_ACCESS_TOKEN
  if (!token) throw new GmailError("Not signed in: GOOGLE_ACCESS_TOKEN is empty. Sign in to Gmail in Box Yard's Settings › Connectors.")
  const res = await fetch(`${API}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) } })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (!res.ok) {
    const why = body?.error?.message ?? text.slice(0, 200)
    if (res.status === 401) throw new GmailError(`Google turned the sign-in down (401): sign in to Gmail again in Box Yard's Settings › Connectors. ${why}`)
    if (res.status === 403) throw new GmailError(`Google refused (403): the sign-in may lack a scope, or the Gmail API isn't enabled in the Google Cloud project. ${why}`)
    throw new GmailError(`Gmail API ${res.status}: ${why}`)
  }
  return body
}

const header = (msg, name) => msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ""
const decode = (data) => Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")

/** The readable text of a message: its text/plain part, else its HTML with the tags taken out. Attachments are listed. */
function bodyOf(payload) {
  let plain = ""
  let html = ""
  const attachments = []
  const walk = (part) => {
    if (!part) return
    if (part.filename && part.body?.attachmentId) attachments.push({ filename: part.filename, mimeType: part.mimeType, size: part.body.size ?? 0 })
    else if (part.mimeType === "text/plain" && part.body?.data && !plain) plain = decode(part.body.data)
    else if (part.mimeType === "text/html" && part.body?.data && !html) html = decode(part.body.data)
    for (const p of part.parts ?? []) walk(p)
  }
  walk(payload)
  let text = plain || stripHtml(html)
  let cut = false
  if (text.length > MAX_BODY) {
    text = text.slice(0, MAX_BODY)
    cut = true
  }
  return { text, cut, attachments }
}

function stripHtml(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** One message, as the read tools return it. */
function messageView(msg) {
  const { text, cut, attachments } = bodyOf(msg.payload)
  return {
    id: msg.id,
    threadId: msg.threadId,
    labelIds: msg.labelIds ?? [],
    from: header(msg, "From"),
    to: header(msg, "To"),
    cc: header(msg, "Cc") || undefined,
    date: header(msg, "Date"),
    subject: header(msg, "Subject"),
    body: cut ? `${text}\n\n[… cut at ${MAX_BODY} characters]` : text,
    attachments,
  }
}

const json = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] })
const failed = (err) => ({ isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] })
const tool = (fn) => async (args) => {
  try {
    return json(await fn(args))
  } catch (err) {
    return failed(err)
  }
}

/** An RFC 2822 message for a draft. Header values lose line breaks, so nothing can add a header. */
function rfc2822({ to, cc, bcc, subject, body, inReplyTo, references }) {
  const clean = (v) => String(v).replace(/[\r\n]+/g, " ").trim()
  const encodeWord = (v) => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`)
  const lines = [`To: ${clean(to)}`]
  if (cc) lines.push(`Cc: ${clean(cc)}`)
  if (bcc) lines.push(`Bcc: ${clean(bcc)}`)
  lines.push(`Subject: ${encodeWord(clean(subject))}`)
  if (inReplyTo) lines.push(`In-Reply-To: ${clean(inReplyTo)}`)
  if (references) lines.push(`References: ${clean(references)}`)
  lines.push("MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", Buffer.from(body, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n"))
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url")
}

const server = new McpServer({ name: "gmail", version: "1.0.0" }, { instructions: "Gmail, read-only plus drafts. There is no send tool: create a draft, and its owner reads and sends it from Gmail." })

server.registerTool(
  "search_messages",
  {
    title: "Search messages",
    description: "Search the mailbox with Gmail's search syntax (from:, to:, subject:, is:unread, newer_than:7d, label:, has:attachment …). Returns each message's id, thread id, sender, subject, date and snippet; read one with read_message or read_thread.",
    inputSchema: {
      query: z.string().max(1000).describe("Gmail search, as typed in Gmail's search box. Empty: the newest messages."),
      max_results: z.number().int().min(1).max(MAX_RESULTS).optional().describe(`How many (default 10, at most ${MAX_RESULTS}).`),
      page_token: z.string().max(200).optional().describe("nextPageToken from the previous page."),
      include_spam_trash: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  tool(async ({ query, max_results, page_token, include_spam_trash }) => {
    const q = new URLSearchParams({ maxResults: String(max_results ?? 10) })
    if (query) q.set("q", query)
    if (page_token) q.set("pageToken", page_token)
    if (include_spam_trash) q.set("includeSpamTrash", "true")
    const list = await gmail(`/messages?${q}`)
    const ids = (list?.messages ?? []).map((m) => m.id)
    const messages = await Promise.all(
      ids.map(async (id) => {
        const m = await gmail(`/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`)
        return { id: m.id, threadId: m.threadId, from: header(m, "From"), to: header(m, "To"), subject: header(m, "Subject"), date: header(m, "Date"), snippet: m.snippet ?? "", labelIds: m.labelIds ?? [] }
      }),
    )
    return { messages, resultSizeEstimate: list?.resultSizeEstimate ?? messages.length, nextPageToken: list?.nextPageToken ?? null }
  }),
)

server.registerTool(
  "read_message",
  {
    title: "Read a message",
    description: "One message in full: headers, its text (HTML turned into text, long bodies cut), and its attachments' names and sizes.",
    inputSchema: { id: z.string().min(1).max(200).describe("The message id from search_messages.") },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  tool(async ({ id }) => messageView(await gmail(`/messages/${encodeURIComponent(id)}?format=full`))),
)

server.registerTool(
  "read_thread",
  {
    title: "Read a thread",
    description: "Every message of a conversation, oldest first, each as read_message gives it.",
    inputSchema: { id: z.string().min(1).max(200).describe("The thread id from search_messages.") },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  tool(async ({ id }) => {
    const t = await gmail(`/threads/${encodeURIComponent(id)}?format=full`)
    return { id: t.id, messages: (t.messages ?? []).map(messageView) }
  }),
)

server.registerTool(
  "list_labels",
  {
    title: "List labels",
    description: "The mailbox's labels (system ones like INBOX and UNREAD, and the user's own), with their ids for search's label: and the message labelIds.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  tool(async () => {
    const r = await gmail("/labels")
    return { labels: (r?.labels ?? []).map((l) => ({ id: l.id, name: l.name, type: l.type })) }
  }),
)

server.registerTool(
  "get_profile",
  {
    title: "Which mailbox",
    description: "The signed-in mailbox's address and its message and thread counts.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  tool(async () => {
    const p = await gmail("/profile")
    return { emailAddress: p.emailAddress, messagesTotal: p.messagesTotal, threadsTotal: p.threadsTotal }
  }),
)

server.registerTool(
  "create_draft",
  {
    title: "Create a draft",
    description: "Write a plain-text draft into Gmail's Drafts. It is not sent: its owner reviews and sends it from Gmail. To reply, give reply_to_message_id: the draft joins that thread with the right headers (and Re: subject).",
    inputSchema: {
      to: z.string().min(1).max(2000).describe("Recipients, comma separated."),
      subject: z.string().max(500).optional().describe("Defaults to Re: <original subject> for a reply."),
      body: z.string().max(100_000).describe("Plain text."),
      cc: z.string().max(2000).optional(),
      bcc: z.string().max(2000).optional(),
      reply_to_message_id: z.string().max(200).optional().describe("The message id this replies to."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  tool(async ({ to, subject, body, cc, bcc, reply_to_message_id }) => {
    let threadId
    let inReplyTo
    let references
    let subj = subject ?? ""
    if (reply_to_message_id) {
      const orig = await gmail(`/messages/${encodeURIComponent(reply_to_message_id)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Subject`)
      threadId = orig.threadId
      inReplyTo = header(orig, "Message-ID") || undefined
      references = [header(orig, "References"), inReplyTo].filter(Boolean).join(" ") || undefined
      if (!subject) {
        const s = header(orig, "Subject")
        subj = /^re:/i.test(s) ? s : `Re: ${s}`
      }
    }
    const raw = rfc2822({ to, cc, bcc, subject: subj, body, inReplyTo, references })
    const d = await gmail("/drafts", { method: "POST", body: JSON.stringify({ message: { raw, ...(threadId ? { threadId } : {}) } }) })
    return { draftId: d.id, messageId: d.message?.id ?? null, threadId: d.message?.threadId ?? threadId ?? null, note: "Saved in Gmail's Drafts, not sent." }
  }),
)

await server.connect(new StdioServerTransport())
