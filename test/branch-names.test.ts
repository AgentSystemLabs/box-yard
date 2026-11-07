import { describe, expect, it } from "vitest"
import { branchName, parseBranchEvidence, type BranchEvidence } from "../server/branchNames.js"

const evidence = (branches: string[] = [], merged: string[] = [], documents: string[] = []): BranchEvidence => ({ branches, merged, documents })
const name = (title: string, branches: string[], prompt = "") => branchName({ title, prompt, evidence: evidence(branches) })

describe("repository branch conventions", () => {
  it("uses a descriptive plain slug with no automatic suffix when there is no clear convention", () => {
    expect(name("Improve café search!", [])).toBe("improve-cafe-search")
    expect(name("Improve search", ["main", "feature/one", "fix/two", "task/three"])).toBe("improve-search")
    expect(name("!!!", [])).toBe("task")
  })

  it.each(["feature", "feat", "task", "fix", "bug", "bugfix", "chore"])("learns repeated %s/ prefixes", (prefix) => {
    const title = /fix|bug/.test(prefix) ? "Fix login" : prefix === "chore" ? "Chore update packages" : "Add search"
    expect(name(title, [`${prefix}/first-change`, `${prefix}/second-change`, "main"])).toBe(`${prefix}/${prefix === "chore" ? "update-packages" : /fix|bug/.test(prefix) ? "login" : "add-search"}`)
  })

  it("selects the task's change type when the repository uses several prefixes", () => {
    const branches = ["feature/new-menu", "feature/new-search", "fix/old-menu", "fix/old-search", "docs/guide", "docs/setup"]
    expect(name("Fix login", branches)).toBe("fix/login")
    expect(name("Add login", branches)).toBe("feature/add-login")
    expect(name("Docs login flow", branches)).toBe("docs/login-flow")
  })

  it("prefers recent merged head refs to old remote branches", () => {
    expect(branchName({ title: "Add search", evidence: evidence(["task/old-one", "task/old-two", "task/old-three"], ["feature/new-one", "feature/new-two"]) })).toBe("feature/add-search")
    expect(branchName({ title: "Add search", evidence: evidence([], ["feature/only", "feature/only"]) })).toBe("add-search")
  })

  it("ignores legacy tool brands, asset branches, base branches and recovery refs", () => {
    expect(name("Improve search", ["boxyard/old-1a2b", "boxyard/old-2a3b", "cursor/old-a", "cursor/old-b", "claude/old-a", "codex/old-b", "boxyard-assets", "pr-assets", "pr-images-one", "pr-images-two", "refs/boxyard/wip/task_123", "level-4-epic", "main"])).toBe("improve-search")
  })

  it.each([
    [["ABC-12-old-menu", "ABC-13-old-search"], "Fix ABC-42 login", "ABC-42-fix-login"],
    [["123-old-menu", "124-old-search"], "Fix #42 login", "42-fix-login"],
    [["issue-12-old-menu", "issue-13-old-search"], "Fix issue #42 login", "issue-42-fix-login"],
    [["fix/ABC-12-old-menu", "fix/ABC-13-old-search"], "Fix ABC-42 login", "fix/ABC-42-login"],
    [["old-menu-12", "old-search-13"], "Fix story 42 login", "fix-login-42"],
  ])("matches ticket placement in %j", (branches, title, expected) => {
    expect(name(title, branches)).toBe(expected)
  })

  it("reads issue references from the prompt and never borrows a number from another task", () => {
    expect(name("Improve search", ["123-old-menu", "124-old-search"], "See https://github.com/acme/site/issues/42")).toBe("42-improve-search")
    expect(name("Improve search", ["ABC-12-old-menu", "ABC-13-old-search"])).toBe("improve-search")
    expect(name("Improve search", [], "Work on ABC-42")).toBe("ABC-42-improve-search")
    expect(name("DEF-42 Fix login", ["fix/ABC-12-old-menu", "fix/ABC-13-old-search"])).toBe("fix/DEF-42-login")
    expect(name("Fix abc-42 login", ["fix/abc-12-old-menu", "fix/abc-13-old-search"])).toBe("fix/abc-42-login")
    expect(name("Improve map-4 navigation", [])).toBe("improve-map-4-navigation")
    expect(name("Fix issue-42 login", ["issue-12-old-menu", "issue-13-old-search"])).toBe("issue-42-fix-login")
    expect(name("Fix #42 login", [])).toBe("42-fix-login")
  })

  it.each([
    [["feature/first_change", "feature/second_change"], "feature/add_search"],
    [["FIRST_CHANGE", "SECOND_CHANGE"], "ADD_SEARCH"],
    [["firstChange", "secondChange"], "addSearch"],
    [["FirstChange", "SecondChange"], "AddSearch"],
  ])("matches separator and casing in %j", (branches, expected) => {
    expect(name("Add search", branches)).toBe(expected)
  })

  it.each([
    ["Branch names must use `feature/<slug>`.", "feature/42-add-search"],
    ["## Branch naming\nUse `task/<description>` for new work.", "task/42-add-search"],
    ["Branches: `feature/<ticket>-<slug>`; use snake_case.", "feature/42_add_search"],
    ["Branches: `<type>/ABC-<ticket>-<description>`.", "feature/ABC-42-add-search"],
    ["git checkout -b feature/<description>", "feature/42-add-search"],
    ["Use camelCase branch names.", "42-addSearch"],
    ["Branch names: `boxyard/<slug>`.", "42-add-search"],
    ["Branches:\n- `feature/` for features\n- `fix/` for fixes", "feature/42-add-search"],
  ])("honors documented guidance: %s", (doc, expected) => {
    expect(branchName({ title: "Add search", prompt: "Issue #42", evidence: evidence(["fix/old-one", "fix/old-two"], [], [doc]) })).toBe(expected)
  })

  it("adds a short suffix only when a remote, merged head or another task already uses the name", () => {
    expect(branchName({ title: "Add search", evidence: evidence(["add-search"]), suffix: () => "a1b2" })).toBe("add-search-a1b2")
    expect(branchName({ title: "Add search", evidence: evidence([], ["add-search"]), suffix: () => "a1b2" })).toBe("add-search-a1b2")
    let i = 0
    expect(branchName({ title: "Add search", occupied: ["add-search", "add-search-1"], suffix: () => String(++i) })).toBe("add-search-2")
    expect(branchName({ title: "Add search", occupied: ["add-search/child"], suffix: () => "a1b2" })).toBe("add-search-a1b2")
    expect(branchName({ title: "Fix search", evidence: evidence(["fix/old-one", "fix/old-two", "fix"]) })).toBe("fix-search")
    expect(branchName({ title: "Add search", evidence: evidence(["FIRST_CHANGE", "SECOND_CHANGE", "ADD_SEARCH"]), suffix: () => "a1b2" })).toBe("ADD_SEARCH_A1B2")
  })

  it("tolerates missing or malformed optional evidence", () => {
    expect(parseBranchEvidence("gh unavailable")).toEqual(evidence())
    expect(parseBranchEvidence('boxyard-branch-evidence={"branches":["fix/a",3],"merged":null}')).toEqual(evidence(["fix/a"]))
    expect(parseBranchEvidence("boxyard-branch-evidence=oops")).toEqual(evidence())
  })
})
