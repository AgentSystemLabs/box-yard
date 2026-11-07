// The files waiting in a composer for the next send: how far each upload got, and what a failed one says.
import type { Attachment } from "../../../shared/types"

export interface PendingFile {
  key: number
  name: string
  size: number
  mime: string
  /** An object URL for an image picked here. A restored draft has none and shows the uploaded copy. */
  preview: string | null
  status: "uploading" | "done" | "error"
  /** Whole percent sent so far, once the browser reports it. */
  progress?: number
  /** Why it failed, naming the file. */
  error?: string
  attachment?: Attachment
  /** The picked file, kept until it uploads so a failure can be retried. None when retrying can't help (too large). */
  file?: File
}

/** The share sent (0 to 1) as the whole percent shown, so a label only changes when its number does. */
export const percent = (sent: number) => Math.max(0, Math.min(100, Math.floor(sent * 100)))

export const tooLargeError = (name: string, maxMb: number) => `"${name}" is larger than the ${maxMb} MB upload limit.`

export const uploadError = (name: string, message: string) => `"${name}" didn't upload: ${message}`

/** Failed files hold the send until they're retried or removed: what went wrong, and what to do about it. */
export function uploadProblem(files: readonly PendingFile[]): { errors: string[]; fix: string } | null {
  const failed = files.filter((f) => f.status === "error")
  if (!failed.length) return null
  const them = failed.length === 1 ? "it" : "them"
  return {
    errors: failed.map((f) => f.error ?? `"${f.name}" didn't upload.`),
    fix: failed.some((f) => f.file) ? `Retry or remove ${them} to send.` : `Remove ${them} to send.`,
  }
}
