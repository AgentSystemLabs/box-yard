// The task id in a task's header: what clicking it does (copy it). Pure apart from the injected clipboard, so it is
// unit tested.
import { isPlainClick } from "./filePreview"
import type { ClickLike } from "./linkify"

/**
 * Click on the task id: a plain click copies it (and cancels the navigation); Cmd/Ctrl, Shift and middle clicks
 * keep the link's new-tab behavior ("skipped").
 */
export async function copyIdOnClick(
  e: ClickLike,
  id: string,
  clipboard: Pick<Clipboard, "writeText"> | undefined = navigator.clipboard,
): Promise<"copied" | "failed" | "skipped"> {
  if (!isPlainClick(e)) return "skipped"
  e.preventDefault()
  if (!clipboard) return "failed"
  try {
    await clipboard.writeText(id)
    return "copied"
  } catch {
    return "failed"
  }
}
