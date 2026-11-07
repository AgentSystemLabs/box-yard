// @vitest-environment happy-dom
// The tree view's moves on their own (lib/treeView.ts), on a small tree drawn by hand: where each key goes, type-ahead,
// and what takes the focus when its item goes.
import { describe, expect, it } from "vitest"
import { treeItems, treeMove, treeSuccessor, typeAheadMatch } from "../web/src/lib/treeView.js"

/** `rows`: [key, level, expanded?], top to bottom; a key is also the item's name. */
function draw(rows: [string, number, boolean?][]) {
  const tree = document.createElement("div")
  tree.setAttribute("role", "tree")
  for (const [key, level, expanded] of rows) {
    const item = document.createElement("div")
    item.setAttribute("role", "treeitem")
    item.dataset.treeKey = key
    item.setAttribute("aria-level", String(level))
    if (expanded !== undefined) item.setAttribute("aria-expanded", String(expanded))
    const open = document.createElement("button")
    open.setAttribute("data-tree-open", "")
    open.textContent = key
    item.append(open)
    tree.append(item)
  }
  const items = treeItems(tree)
  const at = (key: string) => items.find((i) => i.dataset.treeKey === key)!
  return { items, at }
}

const { items, at } = draw([
  ["Coordinator", 1],
  ["box-yard", 1, true],
  ["Plan", 2, true],
  ["Post", 3],
  ["Pick", 3],
  ["Build", 2],
  ["site", 1, false],
])
const move = (from: string, key: string) => treeMove(items, at(from), key)?.dataset.treeKey ?? null

describe("treeMove", () => {
  it("↓ and ↑ go to the next and the previous item, and stop at the ends", () => {
    expect(move("Plan", "ArrowDown")).toBe("Post")
    expect(move("Build", "ArrowUp")).toBe("Pick")
    expect(move("site", "ArrowDown")).toBeNull()
    expect(move("Coordinator", "ArrowUp")).toBeNull()
  })

  it("Home and End go to the first and the last", () => {
    expect(move("Post", "Home")).toBe("Coordinator")
    expect(move("Post", "End")).toBe("site")
  })

  it("→ steps into an unfolded item's first child; a folded one or a leaf stays", () => {
    expect(move("box-yard", "ArrowRight")).toBe("Plan")
    expect(move("Plan", "ArrowRight")).toBe("Post")
    expect(move("site", "ArrowRight")).toBeNull()
    expect(move("Post", "ArrowRight")).toBeNull()
  })

  it("← steps out to the parent, at any depth; a top item stays", () => {
    expect(move("Pick", "ArrowLeft")).toBe("Plan")
    expect(move("Build", "ArrowLeft")).toBe("box-yard")
    expect(move("Plan", "ArrowLeft")).toBe("box-yard")
    expect(move("box-yard", "ArrowLeft")).toBeNull()
  })

  it("an unfolded item with no child drawn yet stays on →", () => {
    const { items, at } = draw([
      ["a", 1, true],
      ["b", 1],
    ])
    expect(treeMove(items, at("a"), "ArrowRight")).toBeNull()
  })
})

describe("typeAheadMatch", () => {
  const match = (from: string, typed: string) => typeAheadMatch(items, at(from), typed)?.dataset.treeKey ?? null

  it("a letter finds the next name starting with it, below the focus and round to the top", () => {
    expect(match("Coordinator", "p")).toBe("Plan")
    expect(match("Plan", "p")).toBe("Post")
    expect(match("Pick", "p")).toBe("Plan")
    expect(match("site", "c")).toBe("Coordinator")
  })

  it("a word may be the item it's on", () => {
    expect(match("Plan", "pl")).toBe("Plan")
    expect(match("Plan", "pi")).toBe("Pick")
  })

  it("no match is null", () => {
    expect(match("Plan", "z")).toBeNull()
  })
})

describe("treeSuccessor", () => {
  const before = ["Coordinator", "box-yard", "Plan", "Post", "Pick", "Build", "site"]

  it("is the same item drawn again, if it's back", () => {
    expect(treeSuccessor(items, before, "Post")).toBe(at("Post"))
  })

  it("else the next one that was below it, else the one above", () => {
    const { items: left } = draw([
      ["Coordinator", 1],
      ["box-yard", 1, true],
      ["Plan", 2, false],
      ["Build", 2],
      ["site", 1, false],
    ])
    expect(treeSuccessor(left, before, "Post")?.dataset.treeKey).toBe("Build")
    const { items: top } = draw([
      ["Coordinator", 1],
      ["box-yard", 1, false],
    ])
    expect(treeSuccessor(top, before, "site")?.dataset.treeKey).toBe("box-yard")
  })

  it("else the first", () => {
    expect(treeSuccessor(items, [], "gone")).toBe(at("Coordinator"))
  })
})
