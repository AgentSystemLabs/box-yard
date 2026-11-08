import type { Attachment } from "../../../shared/types"
import type { ValidationField } from "../../../shared/identityValidation"
import { takeEarly } from "./boot"

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly fields?: ValidationField[],
  ) {
    super(message)
  }
}

/**
 * fetch() for the Box Yard API: JSON in, JSON out, readable errors. `priority: "low"` for background prefetches. `raw`
 * sends a file as the body itself (a project's icon), instead of JSON.
 */
export async function api<T>(path: string, init: { method?: string; body?: unknown; raw?: Blob; priority?: RequestPriority; signal?: AbortSignal } = {}): Promise<T> {
  // A GET of what the page already asked for as it loaded takes that answer (lib/boot.ts).
  const early = init.method === undefined && init.body === undefined && init.raw === undefined ? takeEarly(path) : undefined
  if (early) {
    const data = await early
    if (data !== undefined) return data as T
  }
  let res: Response
  try {
    res = await fetch(path, {
      method: init.method ?? (init.body === undefined && init.raw === undefined ? "GET" : "POST"),
      headers: init.raw !== undefined ? { "Content-Type": "application/octet-stream" } : init.body === undefined ? undefined : { "Content-Type": "application/json" },
      body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
      credentials: "same-origin",
      ...(init.signal ? { signal: init.signal } : {}),
      ...(init.priority ? { priority: init.priority } : {}),
    })
  } catch {
    throw new ApiError("Can't reach the Box Yard server. Is it running?", 0)
  }
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!res.ok) {
    const message = (data as { error?: string } | null)?.error ?? `Request failed (${res.status})`
    if (res.status === 401) window.dispatchEvent(new Event("box-yard:unauthorized"))
    throw new ApiError(message, res.status, (data as { fields?: ValidationField[] } | null)?.fields)
  }
  return data as T
}

/**
 * Upload one file (raw body) and get back its id to attach to a message. An XMLHttpRequest, since fetch can't report
 * upload progress: `onProgress` gets the share sent so far (0 to 1), and `signal` cancels it (an AbortError).
 */
export function uploadFile(file: File, { onProgress, signal }: { onProgress?: (sent: number) => void; signal?: AbortSignal } = {}): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open("POST", `/api/uploads?name=${encodeURIComponent(file.name || "pasted-file")}`)
    xhr.setRequestHeader("Content-Type", "application/octet-stream")
    if (onProgress) xhr.upload.onprogress = (e) => e.lengthComputable && e.total > 0 && onProgress(Math.min(1, e.loaded / e.total))
    xhr.onerror = () => reject(new ApiError("Can't reach the Box Yard server. Is it running?", 0))
    xhr.onabort = () => reject(new DOMException("Upload canceled", "AbortError"))
    xhr.onload = () => {
      let data: (Attachment & { error?: string }) | null = null
      try {
        data = JSON.parse(xhr.responseText)
      } catch {
        data = null
      }
      if (xhr.status >= 200 && xhr.status < 300 && data) return resolve(data)
      if (xhr.status === 401) window.dispatchEvent(new Event("box-yard:unauthorized"))
      reject(new ApiError(data?.error ?? `Upload failed (${xhr.status})`, xhr.status))
    }
    if (signal?.aborted) return reject(new DOMException("Upload canceled", "AbortError"))
    signal?.addEventListener("abort", () => xhr.abort(), { once: true })
    xhr.send(file)
  })
}

/** Ids the server accepts from the client, so optimistic rows keep their id. */
export function clientId(prefix: "prj" | "task" | "chat" | "sch" | "thr" | "thm") {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12)}`
}
