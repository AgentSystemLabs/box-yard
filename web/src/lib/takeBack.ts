// Cancel on a queued message (QueuedMessages.tsx) takes it back: the server drops it, and its text and files go back
// in the draft it was sent from (lib/composerDraft.ts), so Cody can fix it and send it again. Each mounted box registers
// here under its draft's key ("coordinator", "captain:<projectId>" or "task:<taskId>") to take it and the focus; with
// none on screen, it waits in the draft for the box to come back.
import { prependDraft } from "./composerDraft"
import type { Attachment } from "../../../shared/types"

export interface TakeBackBox {
  /** The panel the box sits in, its message list included: a Cancel in there goes to this box. */
  panel: () => HTMLElement | null
  /** Put the message in the box, ahead of any draft, and focus it. Returns Undo: the box as it was, unless it changed since. */
  take: (text: string, attachments: Attachment[]) => () => void
}

const boxes = new Map<string, TakeBackBox[]>()

/** A box's half: it takes `key`'s cancelled messages until the returned function unregisters it. */
export function registerTakeBack(key: string, box: TakeBackBox): () => void {
  boxes.set(key, [...(boxes.get(key) ?? []), box])
  return () => {
    const left = (boxes.get(key) ?? []).filter((b) => b !== box)
    if (left.length) boxes.set(key, left)
    else boxes.delete(key)
  }
}

/**
 * Put a cancelled message back in its chat's draft and box: the one whose panel holds `from` (the Cancel button), else
 * the newest mounted one (the Coordinator's box with a Captain picked, say, for a message in that Captain's tab).
 * With no box for that chat on screen, the draft keeps it until one opens. Returns its Undo.
 */
export function takeBack(key: string, text: string, attachments: Attachment[], from?: Element | null): () => void {
  const list = boxes.get(key)
  if (!list?.length) return prependDraft(key, text, attachments)
  const box = (from && list.find((b) => b.panel()?.contains(from))) || list[list.length - 1]!
  return box.take(text, attachments)
}
