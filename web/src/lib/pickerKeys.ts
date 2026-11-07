import type { KeyboardEvent } from "react"

/** Typed Composer lists keep focus/caret in the textarea and share selection, wrapping and dismissal keys. */
export function pickerKeyDown<T>(e: KeyboardEvent<HTMLTextAreaElement>, list: {
  options: T[]
  active: number
  setActive: (index: number) => void
  disabled: (option: T) => boolean
  pick: (option: T) => void
  escape: () => void
}): boolean {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault()
    const dir = e.key === "ArrowDown" ? 1 : -1
    for (let i = 1; i <= list.options.length; i++) {
      const to = (list.active + dir * i + list.options.length) % list.options.length
      if (!list.disabled(list.options[to]!)) {
        list.setActive(to)
        break
      }
    }
    return true
  }
  if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
    e.preventDefault()
    const option = list.options[list.active]
    if (option && !list.disabled(option)) list.pick(option)
    return true
  }
  if (e.key === "Escape") {
    e.preventDefault()
    e.stopPropagation()
    list.escape()
    return true
  }
  return false
}
