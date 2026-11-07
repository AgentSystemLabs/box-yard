// The sidebar's keyboard, as a WAI-ARIA tree view (https://www.w3.org/WAI/ARIA/apg/patterns/treeview/): one tab stop
// for the whole tree, ↑/↓ to move, → to unfold or step in, ← to fold or step out, Space to fold or unfold (or open a
// leaf), Enter to open, Home/End, and a letter to jump by name.
//
// It reads the tree from the DOM. A folded item's children aren't drawn, so the treeitems on the page, in order, are
// exactly the visible ones. Each item says what it is with its own attributes (role="treeitem", data-tree-key,
// aria-level, aria-expanded) and marks the button its Enter clicks (TREE_OPEN) and the one that folds it (TREE_TOGGLE):
// a key clicks the same button the mouse does, so the two can't disagree, and the folds stay the click toggles' own.
// The items' positions (aria-posinset, aria-setsize) and the tab stop are written here after each change rather than
// passed to the memo'd rows, so a re-sort or a new row doesn't re-render the rows beside it.
import { useCallback, useLayoutEffect, useRef, type FocusEvent, type KeyboardEvent, type MouseEvent } from "react"

/** On the button an item's Enter clicks: what a click on its row does (open the chat or task). */
export const TREE_OPEN = "data-tree-open"
/** On the button that folds or unfolds an item: its chevron, or the whole row for a group that only folds. */
export const TREE_TOGGLE = "data-tree-toggle"

const ITEM = "[role=treeitem]"
/** How long a pause starts a new type-ahead word instead of adding to it, in ms. */
const TYPE_AHEAD_MS = 600

/** The tree's items on screen, top to bottom. */
export const treeItems = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>(ITEM)]
const keyOf = (item: Element) => item.getAttribute("data-tree-key")
const levelOf = (item: Element) => Number(item.getAttribute("aria-level")) || 1
/** The item's own button that `attr` marks, or the item itself. */
const part = (item: Element, attr: string) => (item.hasAttribute(attr) ? item : item.querySelector<HTMLElement>(`[${attr}]`)) as HTMLElement | null
/** The item's name, lower case, for type-ahead: its open button's text. */
const nameOf = (item: Element) => (part(item, TREE_OPEN) ?? item).textContent?.trim().toLowerCase() ?? ""

/**
 * Where a key moves the focus from `item`: ↑/↓ the item above or below, Home/End the first or last, → an unfolded
 * item's first child, ← the item's parent. Null when the focus stays (the end of the list, a leaf's →, a top item's ←).
 * Folding and unfolding are the item's own (useTreeView).
 */
export function treeMove(items: readonly HTMLElement[], item: HTMLElement, key: string): HTMLElement | null {
  const at = items.indexOf(item)
  if (at < 0) return null
  switch (key) {
    case "ArrowDown":
      return items[at + 1] ?? null
    case "ArrowUp":
      return items[at - 1] ?? null
    case "Home":
      return items[0] ?? null
    case "End":
      return items.at(-1) ?? null
    case "ArrowRight": {
      const next = items[at + 1]
      return item.getAttribute("aria-expanded") === "true" && next && levelOf(next) > levelOf(item) ? next : null
    }
    case "ArrowLeft": {
      const level = levelOf(item)
      for (let i = at - 1; i >= 0; i--) if (levelOf(items[i]!) < level) return items[i]!
      return null
    }
  }
  return null
}

/**
 * Type-ahead: the first item whose name starts with `typed`, after `from` and round to the top. A longer word may
 * still be the item it's on ("bo", then "box"), so only a single letter starts looking below it.
 */
export function typeAheadMatch(items: readonly HTMLElement[], from: HTMLElement, typed: string): HTMLElement | null {
  const start = items.indexOf(from) + (typed.length > 1 ? 0 : 1)
  for (let i = 0; i < items.length; i++) {
    const item = items[(start + i) % items.length]!
    if (nameOf(item).startsWith(typed)) return item
  }
  return null
}

/**
 * Where the focus goes when its item went (marked done, folded away, gone from the list): the same item drawn again
 * (a task that gained sub-tasks), else the next one that was below it, else the one above, else the first.
 */
export function treeSuccessor(items: readonly HTMLElement[], before: readonly (string | null)[], key: string | null): HTMLElement | null {
  const byKey = new Map(items.map((i) => [keyOf(i), i]))
  const same = byKey.get(key)
  if (same) return same
  const at = before.indexOf(key)
  if (at >= 0) {
    for (let i = at + 1; i < before.length; i++) if (byKey.has(before[i]!)) return byKey.get(before[i]!)!
    for (let i = at - 1; i >= 0; i--) if (byKey.has(before[i]!)) return byKey.get(before[i]!)!
  }
  return items[0] ?? null
}

/** An added or removed node that is, or holds, an item. */
const holdsItems = (node: Node) => node instanceof Element && (node.matches(ITEM) || node.querySelector(ITEM) !== null)

const setAttr = (el: Element, name: string, value: string) => {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value)
}

/** Each item's place among its siblings: the items in the same list (the tree, or a group in it). */
function writePositions(root: HTMLElement, items: readonly HTMLElement[]) {
  const lists = new Map<Element, HTMLElement[]>()
  for (const item of items) {
    const list = item.parentElement?.closest("[role=group], [role=tree]") ?? root
    const siblings = lists.get(list)
    if (siblings) siblings.push(item)
    else lists.set(list, [item])
  }
  for (const siblings of lists.values()) {
    siblings.forEach((item, i) => {
      setAttr(item, "aria-posinset", String(i + 1))
      setAttr(item, "aria-setsize", String(siblings.length))
    })
  }
}

const setStop = (items: readonly HTMLElement[], stop: HTMLElement | undefined) => {
  for (const item of items) setAttr(item, "tabindex", item === stop ? "0" : "-1")
}

/** Focus an item from the keyboard and bring it into view, no further than needed. */
function focusItem(item: HTMLElement) {
  item.focus({ preventScroll: true })
  item.scrollIntoView?.({ block: "nearest" })
}

/**
 * The tree's behaviour, spread onto its role="tree" element. `current`: the key of the item for the page on screen,
 * where Tab enters the tree until Cody moves the focus in it; after that Tab comes back to the item focused last, until
 * another page opens.
 */
export function useTreeView<T extends HTMLElement = HTMLDivElement>(current: string | null) {
  const root = useRef<T | null>(null)
  const state = useRef({
    /** The item focused last, while the focus is in the tree (or went with its item). */
    focused: null as HTMLElement | null,
    /** The tab stop's key, once the focus has been in the tree since the page last changed. */
    active: null as string | null,
    /** The items' keys as last drawn, to find what took a removed item's place. */
    order: [] as (string | null)[],
    current,
    typed: "",
    typedAt: 0,
  })

  /** After every change: what took the focus's place if its item went, the positions, and the one tab stop. */
  const sync = useCallback(() => {
    const tree = root.current
    if (!tree) return
    const s = state.current
    const items = treeItems(tree)
    const lost = s.focused
    if (lost && !lost.isConnected) {
      s.focused = null
      const now = document.activeElement
      // Only if nothing else took the focus meanwhile.
      if (!now || now === document.body) {
        const next = treeSuccessor(items, s.order, keyOf(lost))
        if (next) {
          s.active = keyOf(next)
          focusItem(next)
        }
      }
    }
    s.order = items.map(keyOf)
    writePositions(tree, items)
    const find = (key: string | null) => (key === null ? undefined : items.find((i) => keyOf(i) === key))
    setStop(items, find(s.active) ?? find(s.current) ?? items[0])
  }, [])

  // The host renders on every change to what the tree lists (tasks, folds, pins), so this keeps up in the same commit.
  useLayoutEffect(() => {
    const s = state.current
    if (s.current !== current) {
      s.current = current
      // Another page opened: Tab comes back to it, unless Cody is moving about the tree right now.
      if (!root.current?.contains(document.activeElement)) s.active = null
    }
    sync()
  })

  // And a part that adds or drops items on its own (a memo'd list's own fold), a microtask later. A callback ref, since
  // the host may draw the tree only some of the time (the sidebar's rail has none).
  const ref = useCallback(
    (tree: T | null) => {
      root.current = tree
      if (!tree) return
      const seen = new MutationObserver((records) => {
        if (records.some((r) => [...r.addedNodes, ...r.removedNodes].some(holdsItems))) sync()
      })
      seen.observe(tree, { childList: true, subtree: true })
      return () => {
        seen.disconnect()
        root.current = null
      }
    },
    [sync],
  )

  const onFocus = useCallback((e: FocusEvent<T>) => {
    const item = (e.target as Element).closest<HTMLElement>(ITEM)
    if (!item || !e.currentTarget.contains(item)) return
    const s = state.current
    s.focused = item
    s.active = keyOf(item)
    setStop(treeItems(e.currentTarget), item)
  }, [])

  const onBlur = useCallback((e: FocusEvent<T>) => {
    const root = e.currentTarget
    if (e.relatedTarget instanceof Node && root.contains(e.relatedTarget)) return
    const s = state.current
    const was = s.focused
    // Cody moved on, unless the item went with the focus: then sync() hands it to the item that took its place.
    queueMicrotask(() => {
      if (s.focused === was && was?.isConnected && !root.contains(document.activeElement)) s.focused = null
    })
  }, [])

  const onKeyDown = useCallback((e: KeyboardEvent<T>) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.nativeEvent.isComposing) return
    const root = e.currentTarget
    const item = (e.target as Element).closest<HTMLElement>(ITEM)
    if (!item || !root.contains(item)) return
    // A button inside the row (a mouse put the focus there) keeps its own Enter and Space.
    const onItem = e.target === item
    const expanded = item.getAttribute("aria-expanded")
    const items = treeItems(root)
    let to: HTMLElement | null = null
    switch (e.key) {
      case "Enter":
        if (!onItem) return
        part(item, TREE_OPEN)?.click()
        break
      case " ":
        if (!onItem || e.shiftKey) return
        part(item, expanded === null ? TREE_OPEN : TREE_TOGGLE)?.click()
        break
      case "ArrowRight":
      case "ArrowLeft":
        if (e.shiftKey) return
        // → unfolds a folded item and ← folds an unfolded one; otherwise they step in and out.
        if (expanded === (e.key === "ArrowRight" ? "false" : "true")) part(item, TREE_TOGGLE)?.click()
        else to = treeMove(items, item, e.key)
        break
      case "ArrowDown":
      case "ArrowUp":
      case "Home":
      case "End":
        if (e.shiftKey) return
        to = treeMove(items, item, e.key)
        break
      default: {
        // Letters and digits only: "/" (the palette), "?" (the shortcuts) and the rest stay the app's.
        if (e.key.length !== 1 || !/[\p{L}\p{N}]/u.test(e.key)) return
        const s = state.current
        const now = e.timeStamp
        s.typed = now - s.typedAt < TYPE_AHEAD_MS ? s.typed + e.key.toLowerCase() : e.key.toLowerCase()
        s.typedAt = now
        to = typeAheadMatch(items, item, s.typed)
      }
    }
    e.preventDefault()
    if (to) focusItem(to)
  }, [])

  // A screen reader's click (VoiceOver's VO+Space, NVDA's Enter in browse mode) lands on the item itself, not its
  // button: it opens it as Enter does. A mouse's lands on a button (detail 1+), as before.
  const onClick = useCallback((e: MouseEvent<T>) => {
    const target = e.target as Element
    if (e.detail !== 0 || !target.matches(ITEM) || !e.currentTarget.contains(target)) return
    const open = part(target, TREE_OPEN)
    if (open !== target) open?.click()
  }, [])

  return { ref, onFocus, onBlur, onKeyDown, onClick }
}
