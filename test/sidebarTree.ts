// The sidebar's tree (web/src/lib/treeView.ts) as the UI tests read it: rows are treeitems named by their open button
// (aria-labelledby), and a group's section holds its head row and, unfolded, its rows.

/** The name a treeitem goes by: its labelling button's text. */
export function itemName(item: Element): string {
  const id = item.getAttribute("aria-labelledby")
  return ((id && item.ownerDocument.getElementById(id)) || item).textContent ?? ""
}

/** The treeitems in `within`, top to bottom. */
export const treeItems = (within: ParentNode) => [...within.querySelectorAll<HTMLElement>("[role=treeitem]")]

/**
 * A group of the sidebar (a project, "Waiting on you", More projects) by its name: the box around its head row and its
 * rows. A project's head says "<name>, Captain", the others their count after the name.
 */
export function sidebarGroup(within: ParentNode, name: string): HTMLElement | null {
  const named = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(,|\\d|$)`)
  const head = treeItems(within).find((i) => i.getAttribute("aria-level") === "1" && named.test(itemName(i)))
  return head?.parentElement ?? null
}
