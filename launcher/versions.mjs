// Which installed version runs (app/current → versions/<sha>), which ran before it, and which updates failed.
import fs from "node:fs"
import path from "node:path"
import { isInstalled } from "./install.mjs"

/** The sha `current` points at, when that version is whole; else null. */
export function currentVersion(layout) {
  try {
    const target = fs.readlinkSync(layout.current)
    const sha = path.basename(target)
    return /^[0-9a-f]{40}$/.test(sha) && isInstalled(path.join(layout.versions, sha)) ? sha : null
  } catch {
    return null
  }
}

/** Point `current` at versions/<sha>, in one step (a new link renamed over the old one). */
export function setCurrent(layout, sha) {
  const tmp = `${layout.current}.tmp-${process.pid}`
  fs.rmSync(tmp, { force: true })
  fs.symlinkSync(path.join("versions", sha), tmp)
  fs.renameSync(tmp, layout.current)
}

/** { previous, failed: { [sha]: { at, error } }, last: { from, to, ok, at, error? } } */
export function readState(layout) {
  try {
    const s = JSON.parse(fs.readFileSync(layout.state, "utf8"))
    return { previous: s.previous ?? null, failed: s.failed ?? {}, last: s.last ?? null }
  } catch {
    return { previous: null, failed: {}, last: null }
  }
}

export function writeState(layout, state) {
  fs.mkdirSync(path.dirname(layout.state), { recursive: true })
  const tmp = `${layout.state}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n")
  fs.renameSync(tmp, layout.state)
}

/** Staging folders older than this belong to an install that died. */
const STALE_STAGING_MS = 60 * 60_000

/**
 * Delete installed versions not in `keep` (the current one, the one before it, and the one this launcher itself runs
 * from), and staging folders an interrupted install left. Returns the shas it removed.
 */
export function pruneVersions(layout, keep, now = Date.now()) {
  const removed = []
  for (const name of safeList(layout.versions)) {
    if (keep.has(name)) continue
    fs.rmSync(path.join(layout.versions, name), { recursive: true, force: true })
    removed.push(name)
  }
  for (const name of safeList(layout.app)) {
    if (!name.startsWith("staging-")) continue
    const dir = path.join(layout.app, name)
    try {
      if (now - fs.statSync(dir).mtimeMs > STALE_STAGING_MS) fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // gone already
    }
  }
  return removed
}

/** The version folder a file sits in (this launcher's own, when it runs from an install), or null. */
export function versionOfPath(layout, file) {
  const rel = path.relative(fs.realpathSync(layout.versions), safeRealpath(file))
  const first = rel.split(path.sep)[0]
  return !rel.startsWith("..") && /^[0-9a-f]{40}$/.test(first ?? "") ? first : null
}

const safeList = (dir) => {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

const safeRealpath = (file) => {
  try {
    return fs.realpathSync(file)
  } catch {
    return file
  }
}

/** "abc1234" */
export const short = (sha) => (sha ? sha.slice(0, 7) : "unknown")
