import { execFileSync, spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

/** Include committed, staged, unstaged and untracked changes, relative to the branch's merge base. */
export function changedFiles(base = "origin/main", cwd = process.cwd()): string[] {
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  const mergeBase = git("merge-base", "HEAD", base).trim()
  return [...new Set([
    ...git("diff", "--name-only", "--no-renames", "-z", mergeBase, "--").split("\0"),
    ...git("ls-files", "--others", "--exclude-standard", "-z").split("\0"),
  ].filter(Boolean))].sort()
}

export function runRelated(args = process.argv.slice(2)): number {
  let base = "origin/main"
  if (args[0] === "--base") {
    if (!args[1]) throw new Error("Usage: npm run test:related -- [--base <git ref>] [vitest options]")
    base = args[1]
    args = args.slice(2)
  }
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()
  const files = changedFiles(base, root)
  if (!files.length) {
    console.log(`No changes since the merge base with ${base}; no related tests to run.`)
    return 0
  }
  console.log(`Finding tests related to ${files.length} changed files since the merge base with ${base}.`)
  // Invoke the installed CLI directly, with argv (including paths with spaces), never a shell or npx download.
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url)),
    "related", ...files.map((file) => path.resolve(root, file)), "--run", "--passWithNoTests", ...args,
  ], { cwd: root, stdio: "inherit" })
  if (result.error) throw result.error
  return result.status ?? 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runRelated()
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  }
}
