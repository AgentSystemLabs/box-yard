import { describe, expect, it } from "vitest"
import { subtaskHitsLabel, taskTree, titleHasWords } from "../web/src/lib/subtaskSearch.js"

const t = (id: string, parentTaskId: string | null = null) => ({ id, title: `Task ${id}`, parentTaskId, rootTaskId: null })

describe("taskTree", () => {
  const top = t("top")
  const kid = t("kid", "top")
  const grandkid = t("grandkid", "kid")
  const orphan = t("orphan", "gone")
  const tree = taskTree([top, kid, grandkid, orphan])

  it("finds a sub-task's parent and the top of its tree", () => {
    expect(tree.parent(kid)).toBe(top)
    expect(tree.parent(grandkid)).toBe(kid)
    expect(tree.root(grandkid)).toBe(top)
    expect(tree.root(top)).toBe(top)
    expect(tree.parent(top)).toBeUndefined()
  })

  it("treats a task whose parent isn't in the list as top-level", () => {
    expect(tree.parent(orphan)).toBeUndefined()
    expect(tree.root(orphan)).toBe(orphan)
  })

  it("stops on a parent loop in bad data", () => {
    const a = t("a", "b")
    const b = t("b", "a")
    const self = t("self", "self")
    const loop = taskTree([a, b, self])
    expect([a, b]).toContain(loop.root(a))
    expect(loop.parent(self)).toBeUndefined()
  })
})

describe("helpers", () => {
  it("matches every word of a query in a title, in any order", () => {
    expect(titleHasWords("Logo designer 3", ["designer", "logo"])).toBe(true)
    expect(titleHasWords("Logo designer 3", ["logo", "rater"])).toBe(false)
    expect(titleHasWords("Logo", [])).toBe(false)
  })

  it("says how many sub-tasks match", () => {
    expect(subtaskHitsLabel(1)).toBe("1 sub-task matches")
    expect(subtaskHitsLabel(14)).toBe("14 sub-tasks match")
  })
})
