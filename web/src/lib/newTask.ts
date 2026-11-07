// Drafts for the New task popover, one per place it opens from (a project, "any" where you pick the project, or
// a selected quote), kept with every other box's in lib/composerDraft.ts under "new-task:<scope>".
// Esc, a click outside or "More options" keeps the text, and the full dialog's files with it; starting the task clears
// it. In this tab's memory only, so a reload starts empty.
import { clearDraft, readDraft, setDraftText } from "./composerDraft"

/** Where a draft belongs: the project the popover is for, or "any" when it has a project picker. */
export const draftScope = (projectId: string | null | undefined) => projectId ?? "any"

/** The draft store's key for a scope's draft. */
export const newTaskDraftKey = (scope: string) => `new-task:${scope}`

/** A selection's instructions are kept per quote, so another selection starts empty. */
export function selectionScope(text: string) {
  return `selection:${textHash(text)}`
}

/** A short, stable name for a piece of text (a quote), to key its drafts by. */
export function textHash(text: string) {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

export function loadDraft(scope: string): string {
  return readDraft(newTaskDraftKey(scope)).text
}

/** Keep the text (blank text is none); the draft's files stay. */
export function saveDraft(scope: string, text: string) {
  setDraftText(newTaskDraftKey(scope), text.trim() ? text : "")
}

/** The task started: its text and files go. */
export function clearNewTaskDraft(scope: string) {
  clearDraft(newTaskDraftKey(scope))
}
