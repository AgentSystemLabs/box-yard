// A stand-in for the browser's XMLHttpRequest, which uploadFile (web/src/lib/api.ts) sends uploads with so it can
// report progress. `stubUploads(reply)` installs it: `reply` answers each upload as it's sent, or leave it out and
// drive the returned requests by hand (progress, respond, fail).
import { vi } from "vitest"

type Handler = (() => void) | null

export class FakeUpload {
  method = ""
  url = ""
  headers: Record<string, string> = {}
  body: unknown = undefined
  status = 0
  responseText = ""
  aborted = false
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null }
  onload: Handler = null
  onerror: Handler = null
  onabort: Handler = null

  open(method: string, url: string) {
    this.method = method
    this.url = url
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value
  }
  send(body: unknown) {
    this.body = body
  }
  abort() {
    this.aborted = true
    this.onabort?.()
  }
  /** The browser reports `loaded` of `total` bytes sent. */
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total })
  }
  /** The server answers with JSON (or raw text). */
  respond(status: number, body: unknown) {
    this.status = status
    this.responseText = typeof body === "string" ? body : JSON.stringify(body)
    this.onload?.()
  }
  /** The request never reached the server. */
  fail() {
    this.onerror?.()
  }
}

/** Replace XMLHttpRequest; returns every upload sent from now on, in order. */
export function stubUploads(reply?: (req: FakeUpload) => void): FakeUpload[] {
  const sent: FakeUpload[] = []
  vi.stubGlobal(
    "XMLHttpRequest",
    class extends FakeUpload {
      override send(body: unknown) {
        super.send(body)
        sent.push(this)
        reply?.(this)
      }
    },
  )
  return sent
}
