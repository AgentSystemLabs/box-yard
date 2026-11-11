// Unsent drafts, one per place a message goes: "coordinator", "captain:<projectId>", "task:<taskId>", "thread:<threadId>",
// "new-task:<scope>"… Each holds the text and the files (thumbnails and uploads in flight included). They live in this
// module, outside the boxes, so a draft outlives its box: another session in the nav, a panel or thread closed and
// reopened, the chat switched. An upload keeps going while its box is gone and is there (done, or failed with Retry)
// when the box comes back. Kept in this tab's memory only, never in web storage (conversation data stays in memory:
// test/captain-prefetch.test.ts), so a reload starts empty.
//
// A box reads its draft with useDraft(key) and writes it through these functions; anything else may too (a prefill,
// a taken-back message), mounted box or not. A draft clears on a successful send or when Cody empties it; object URLs
// are freed only then.
import { useCallback, useEffect, useState, useSyncExternalStore } from "react"
import { uploadFile } from "./api"
import { isImage } from "../components/Attachments"
import { percent, tooLargeError, uploadError, type PendingFile } from "./pendingUploads"
import type { SendDestination } from "./sendTo"
import type { Attachment } from "../../../shared/types"

export interface Draft {
  readonly text: string
  readonly files: readonly PendingFile[]
  readonly destination?: SendDestination
}

export const EMPTY_DRAFT: Draft = Object.freeze({ text: "", files: Object.freeze([]) as readonly PendingFile[] })

type Update<T> = T | ((prev: T) => T)

const drafts = new Map<string, Draft>()
const listeners = new Map<string, Set<() => void>>()
/** Uploads in flight, by file key, so Remove (or clearing the draft) cancels them. */
const uploads = new Map<number, AbortController>()
let nextFileKey = 0

const isEmpty = (d: Draft) => !d.text && !d.files.length && !d.destination

export function readDraft(key: string): Draft {
  return drafts.get(key) ?? EMPTY_DRAFT
}

/** Replace `key`'s draft. An empty one is dropped; its box shows an empty draft. */
export function writeDraft(key: string, update: Update<Draft>) {
  const before = readDraft(key)
  const next = typeof update === "function" ? update(before) : update
  if (next === before) return
  if (isEmpty(next)) drafts.delete(key)
  else drafts.set(key, next)
  listeners.get(key)?.forEach((l) => l())
}

export function setDraftText(key: string, text: Update<string>) {
  writeDraft(key, (d) => {
    const next = typeof text === "function" ? text(d.text) : text
    return next === d.text ? d : { ...d, text: next }
  })
}

export function setDraftFiles(key: string, files: Update<readonly PendingFile[]>) {
  writeDraft(key, (d) => {
    const next = typeof files === "function" ? files(d.files) : files
    return next === d.files ? d : { ...d, files: next }
  })
}

export function subscribeDraft(key: string, listener: () => void): () => void {
  let set = listeners.get(key)
  if (!set) listeners.set(key, (set = new Set()))
  set.add(listener)
  return () => {
    set.delete(listener)
    if (!set.size && listeners.get(key) === set) listeners.delete(key)
  }
}

/** `key`'s draft, re-rendering only on its own changes. */
export function useDraft(key: string): Draft {
  const subscribe = useCallback((l: () => void) => subscribeDraft(key, l), [key])
  const read = useCallback(() => readDraft(key), [key])
  return useSyncExternalStore(subscribe, read, read)
}

let nextLocal = 0

/** `key`, or for a box with no target a key of its own whose draft goes when the box does. */
export function useDraftKey(key: string | undefined): string {
  const [own] = useState(() => `local:${nextLocal++}`)
  useEffect(() => {
    if (!key) return () => clearDraft(own)
  }, [key, own])
  return key ?? own
}

/** A file already uploaded (a taken-back message's, a failed send's), as the tray shows it. */
export function uploadedFile(a: Attachment): PendingFile {
  return { key: nextFileKey++, name: a.name, size: a.size, mime: a.mime, preview: null, status: "done", attachment: a }
}

/** The uploaded files' attachments, in order: what a send carries. */
export const draftAttachments = (files: readonly PendingFile[]): Attachment[] => files.flatMap((f) => (f.attachment ? [f.attachment] : []))

/** The files can't go yet: one is still uploading, or one failed (the tray says so). */
export const filesHold = (files: readonly PendingFile[]) => files.some((f) => f.status !== "done")

/** Free the files' thumbnails and cancel their uploads: they're sent, removed or cleared. */
export function releaseFiles(files: readonly PendingFile[]) {
  for (const f of files) {
    uploads.get(f.key)?.abort()
    uploads.delete(f.key)
    if (f.preview) URL.revokeObjectURL(f.preview)
  }
}

const patchFile = (key: string, fileKey: number, change: Partial<PendingFile>) =>
  setDraftFiles(key, (list) => (list.some((f) => f.key === fileKey) ? list.map((f) => (f.key === fileKey ? { ...f, ...change } : f)) : list))

function upload(key: string, fileKey: number, name: string, file: File) {
  const control = new AbortController()
  uploads.set(fileKey, control)
  let shown: number | undefined
  uploadFile(file, {
    signal: control.signal,
    // A re-render per whole percent, not per progress event.
    onProgress: (sent) => {
      if (percent(sent) === shown) return
      shown = percent(sent)
      patchFile(key, fileKey, { progress: shown })
    },
  })
    .then(
      (attachment) => patchFile(key, fileKey, { status: "done", attachment, file: undefined }),
      (err: Error) => {
        if (!control.signal.aborted) patchFile(key, fileKey, { status: "error", error: uploadError(name, err.message) })
      },
    )
    .finally(() => {
      if (uploads.get(fileKey) === control) uploads.delete(fileKey)
    })
}

/** Add picked, pasted or dropped files to `key`'s draft and upload them; one over `maxMb` shows as failed instead. */
export function attachFiles(key: string, picked: File[], maxMb: number) {
  for (const file of picked) {
    const fileKey = nextFileKey++
    const item: PendingFile = {
      key: fileKey,
      name: file.name || "pasted-file",
      size: file.size,
      mime: file.type || "application/octet-stream",
      preview: isImage(file.type) ? URL.createObjectURL(file) : null,
      status: "uploading",
    }
    if (file.size > maxMb * 1024 * 1024) {
      setDraftFiles(key, (list) => [...list, { ...item, status: "error", error: tooLargeError(item.name, maxMb) }])
      continue
    }
    setDraftFiles(key, (list) => [...list, { ...item, file }])
    upload(key, fileKey, item.name, file)
  }
}

/** Upload a failed file again (one that can be: a too-large file has nothing to retry). */
export function retryFile(key: string, fileKey: number) {
  const item = readDraft(key).files.find((f) => f.key === fileKey && f.status === "error")
  if (!item?.file) return
  patchFile(key, fileKey, { status: "uploading", progress: undefined, error: undefined })
  upload(key, fileKey, item.name, item.file)
}

/** Take a file out of the draft, cancelling its upload. */
export function removeFile(key: string, fileKey: number) {
  const gone = readDraft(key).files.find((f) => f.key === fileKey)
  if (!gone) return
  releaseFiles([gone])
  setDraftFiles(key, (list) => list.filter((f) => f.key !== fileKey))
}

/** Empty `key`'s draft for good: its uploads stop and its thumbnails are freed. */
export function clearDraft(key: string) {
  releaseFiles(readDraft(key).files)
  writeDraft(key, EMPTY_DRAFT)
}

/**
 * Put text (and uploaded files) back in `key`'s draft ahead of what's there: a queued message taken back, or another
 * part of the app prefilling a box. Returns Undo: the draft as it was, unless it has changed since.
 */
export function prependDraft(key: string, text: string, attachments: Attachment[] = []): () => void {
  const before = readDraft(key)
  const added = attachments.map(uploadedFile)
  const next: Draft = { ...before, text: before.text.trim() ? (text ? `${text}\n\n${before.text}` : before.text) : text, files: [...added, ...before.files] }
  writeDraft(key, next)
  return () => {
    const now = readDraft(key)
    if (now.text !== next.text) return
    writeDraft(key, { ...now, text: before.text, files: now.files.filter((f) => !added.includes(f)) })
  }
}

/** Drafts with something in them, for tests. */
export const draftKeys = () => [...drafts.keys()]

/** Tests: every draft gone, as after a reload. */
export function resetDrafts() {
  for (const key of [...drafts.keys()]) clearDraft(key)
}
