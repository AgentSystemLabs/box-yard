/** A conversation can return focus without changing its draft, route or panel stack. */
export const FOCUS_SIDEBAR = "box-yard:focus-sidebar"

export function focusSidebar(expand = true): boolean {
  return !window.dispatchEvent(new CustomEvent(FOCUS_SIDEBAR, { cancelable: true, detail: { expand } }))
}

export const isChatComposer = (target: EventTarget | null) => target instanceof Element && target.matches("textarea[data-chat-composer]")
