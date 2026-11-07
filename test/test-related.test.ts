import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { changedFiles } from "../scripts/test-related.js"
import { tmpDir } from "./helpers.js"

function repo() {
  const cwd = tmpDir("related-tests-")
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=t@t", "-c", "commit.gpgSign=false", ...args], { cwd, stdio: "pipe", encoding: "utf8" })
  const put = (file: string, content = file) => fs.writeFileSync(path.join(cwd, file), content)
  git("init", "-q", "-b", "main")
  for (const file of ["committed.ts", "staged.ts", "unstaged.ts", "deleted.ts", "rename.ts"]) put(file)
  put(".gitignore", "ignored/\n")
  git("add", ".")
  git("commit", "-qm", "base")
  git("checkout", "-qb", "feature")
  return { cwd, git, put }
}

describe("related test inputs", () => {
  it("uses the merge base and includes every kind of branch change, preserving spaces", () => {
    const { cwd, git, put } = repo()
    put("committed.ts", "branch")
    git("add", ".")
    git("commit", "-qm", "branch work")
    git("checkout", "-q", "main")
    put("main-only.ts")
    git("add", ".")
    git("commit", "-qm", "main moved")
    git("checkout", "-q", "feature")
    put("staged.ts", "staged")
    git("add", "staged.ts")
    put("unstaged.ts", "dirty")
    fs.rmSync(path.join(cwd, "deleted.ts"))
    git("mv", "rename.ts", "renamed file.ts")
    put("new file.ts")
    fs.mkdirSync(path.join(cwd, "ignored"))
    put("ignored/cache.ts")
    expect(changedFiles("main", cwd)).toEqual(["committed.ts", "deleted.ts", "new file.ts", "rename.ts", "renamed file.ts", "staged.ts", "unstaged.ts"])
  })

  it("returns nothing on a clean branch and fails clearly for an unknown base", () => {
    const { cwd } = repo()
    expect(changedFiles("main", cwd)).toEqual([])
    expect(() => changedFiles("missing-base", cwd)).toThrow()
  })
})
