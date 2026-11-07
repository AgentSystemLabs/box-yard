// A project's own icon (shared/projectIcons.ts): the image Cody uploads in Project settings › General › Icon, shown
// instead of its coloured letter. One file per project, `<dataDir>/project-icons/<projectId>/<hash>.<ext>`, named in
// projects.icon. The type comes from the file's bytes, never its name. Rasters over ICON_SIZE are shrunk with sharp
// (an optional dependency, as for thumbnails); without it, only rasters up to ICON_MAX_UNSHRUNK are taken. SVGs are
// kept as they are and served sandboxed, so a script in one never runs (the app only shows them in an <img>).
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import express, { type Router } from "express"
import { imageSize } from "./imageSize.js"
import { HOSTED_CACHE_CONTROL, MAX_INPUT_PIXELS, loadSharp, type Sharp } from "./thumbs.js"
import { BadRequestError, NotFoundError, type Store } from "./store.js"
import type { Hub } from "./hub.js"
import { PROJECT_ICON_FILE, PROJECT_ICON_MAX_BYTES, PROJECT_ICON_TYPES } from "../shared/projectIcons.js"

export const projectIconsDir = (dataDir: string) => path.join(dataDir, "project-icons")

/** Rasters bigger than this on a side are shrunk to a square of it, cropped from the middle as the app shows them. */
export const ICON_SIZE = 256

/** Without sharp, the largest raster (on a side) kept as it is. */
export const ICON_MAX_UNSHRUNK = 1024

type IconType = "png" | "jpeg" | "webp" | "gif" | "svg"

const EXT: Record<IconType, string> = { png: "png", jpeg: "jpg", webp: "webp", gif: "gif", svg: "svg" }
const LABEL: Record<IconType, string> = { png: "PNG", jpeg: "JPG", webp: "WebP", gif: "GIF", svg: "SVG" }
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml" }

/** Whitespace, an XML declaration, comments and a doctype may come before an SVG's root element. */
const SVG_START = /^(?:\s+|<\?xml[^>]*\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?\s*>)*<svg[\s>/]/i

/** What `data` is by its first bytes (or, for an SVG, its first element): one of the icon types, or null. */
export function sniffIcon(data: Buffer): IconType | null {
  if (data.length >= 8 && data.readUInt32BE(0) === 0x89504e47 && data.readUInt32BE(4) === 0x0d0a1a0a) return "png"
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "jpeg"
  if (data.length >= 6 && /^GIF8[79]a$/.test(data.toString("latin1", 0, 6))) return "gif"
  if (data.length >= 12 && data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP") return "webp"
  const text = data.toString("utf8").replace(/^﻿/, "")
  if (!text.includes("\0") && SVG_START.test(text)) return "svg"
  return null
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`

export function iconTooLarge(bytes: number) {
  const err = new BadRequestError(`That image is ${mb(bytes)}; an icon can be up to ${mb(PROJECT_ICON_MAX_BYTES)}. Pick a smaller one.`)
  err.status = 413
  return err
}

export class ProjectIcons {
  private sharp: Promise<Sharp | null> | null = null

  constructor(
    readonly dir: string,
    private readonly load: () => Promise<Sharp> = loadSharp,
  ) {}

  /** Checks `data`, shrinks it if it's a large raster, and keeps it as one of `projectId`'s icon files: its name. */
  async save(projectId: string, data: Buffer): Promise<string> {
    const { bytes, ext } = await this.prepare(data)
    const name = `${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}.${ext}`
    const folder = this.folder(projectId)
    fs.mkdirSync(folder, { recursive: true })
    // Written aside and renamed, so a request never gets half an icon.
    const tmp = path.join(folder, `${name}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`)
    fs.writeFileSync(tmp, bytes)
    fs.renameSync(tmp, path.join(folder, name))
    return name
  }

  /** The icon file `name` of `projectId`, if it's there. */
  file(projectId: string, name: string): { folder: string; name: string; mime: string } | null {
    if (!PROJECT_ICON_FILE.test(name)) return null
    const folder = this.folder(projectId)
    if (!fs.existsSync(path.join(folder, name))) return null
    return { folder, name, mime: MIME[name.slice(name.lastIndexOf(".") + 1)]! }
  }

  /** Deletes `projectId`'s icon files but `keep` (the one projects.icon names now); all of them with no `keep`. */
  prune(projectId: string, keep: string | null = null) {
    const folder = this.folder(projectId)
    if (!keep) return void fs.rmSync(folder, { recursive: true, force: true })
    let names: string[]
    try {
      names = fs.readdirSync(folder)
    } catch {
      return
    }
    for (const n of names) if (n !== keep) fs.rmSync(path.join(folder, n), { recursive: true, force: true })
  }

  private folder(projectId: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new BadRequestError(`Bad project id "${projectId}"`)
    return path.join(this.dir, projectId)
  }

  private async prepare(data: Buffer): Promise<{ bytes: Buffer; ext: string }> {
    if (!data.length) throw new BadRequestError("That image is empty.")
    if (data.length > PROJECT_ICON_MAX_BYTES) throw iconTooLarge(data.length)
    const type = sniffIcon(data)
    if (!type) throw new BadRequestError(`That file isn't an image an icon can be: use a ${PROJECT_ICON_TYPES}.`)
    if (type === "svg") return { bytes: data, ext: EXT.svg }
    const size = imageSize(data)
    if (!size) throw new BadRequestError(`That ${LABEL[type]} couldn't be read: it may be cut short or damaged.`)
    const side = Math.max(size.width, size.height)
    if (side <= ICON_SIZE) return { bytes: data, ext: EXT[type] }
    if (size.width * size.height > MAX_INPUT_PIXELS) throw new BadRequestError(`That image is ${size.width} × ${size.height} px, too large to shrink into an icon. Use a smaller one.`)
    const sharp = await this.loadOnce()
    if (!sharp) {
      if (side <= ICON_MAX_UNSHRUNK) return { bytes: data, ext: EXT[type] }
      throw new BadRequestError(
        `That image is ${size.width} × ${size.height} px. This server can't shrink images (sharp isn't installed), so an icon can be at most ${ICON_MAX_UNSHRUNK} px on a side: shrink it and upload it again.`,
      )
    }
    try {
      // rotate() applies a phone photo's EXIF orientation, which the shrunk copy doesn't carry. An animated GIF keeps
      // its first frame.
      const bytes = await sharp(data, { limitInputPixels: MAX_INPUT_PIXELS }).rotate().resize({ width: ICON_SIZE, height: ICON_SIZE, fit: "cover" }).webp({ quality: 90 }).toBuffer()
      return { bytes, ext: "webp" }
    } catch {
      throw new BadRequestError(`That ${LABEL[type]} couldn't be read: it may be cut short or damaged.`)
    }
  }

  private loadOnce(): Promise<Sharp | null> {
    this.sharp ??= this.load().catch((err: unknown) => {
      console.warn(`[box-yard] large project icons are refused, not shrunk: sharp didn't load (${err instanceof Error ? err.message : String(err)})`)
      return null
    })
    return this.sharp
  }
}

/**
 * PUT /api/projects/:id/icon (the image as the raw body) sets a project's icon, DELETE takes it off, and GET serves it.
 * The first two answer with the project, as PATCH does, and tell open tabs.
 */
export function projectIconRoutes(api: Router, { store, icons, hub }: { store: Store; icons: ProjectIcons; hub: Pick<Hub, "broadcast"> }) {
  const project = (id: string) => {
    const p = store.getProject(id)
    if (!p) throw new NotFoundError(`Project ${id} not found`)
    return p
  }
  api.put(
    "/projects/:id/icon",
    (req, _res, next) => {
      const length = Number(req.header("content-length") ?? 0)
      if (length > PROJECT_ICON_MAX_BYTES) return next(iconTooLarge(length))
      next()
    },
    express.raw({ type: () => true, limit: PROJECT_ICON_MAX_BYTES }),
    async (req, res) => {
      const id = project(req.params.id!).id
      const name = await icons.save(id, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0))
      // Deleted meanwhile: its folder goes with it.
      if (!store.getProject(id)) {
        icons.prune(id)
        throw new NotFoundError(`Project ${id} not found`)
      }
      const updated = store.setProjectIcon(id, name)
      icons.prune(id, name)
      hub.broadcast({ type: "project", project: updated })
      res.json(updated)
    },
  )
  api.delete("/projects/:id/icon", (req, res) => {
    const id = project(req.params.id!).id
    const updated = store.setProjectIcon(id, null)
    icons.prune(id)
    hub.broadcast({ type: "project", project: updated })
    res.json(updated)
  })
  api.get("/projects/:id/icon", (req, res) => {
    const id = req.params.id!
    const name = store.getProjectIcon(id)
    const file = name ? icons.file(id, name) : null
    if (!name || !file) return void res.status(404).json({ error: "This project has no icon" })
    res.setHeader("Content-Type", file.mime)
    res.setHeader("X-Content-Type-Options", "nosniff")
    // Shown as an image, never as a page: an SVG's scripts don't run, and it loads nothing from anywhere.
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox")
    // The URL names the file's hash (?v=), so the current one is kept for good; any other is checked each time.
    res.setHeader("Cache-Control", req.query.v === name.slice(0, name.indexOf(".")) ? HOSTED_CACHE_CONTROL : "no-cache")
    // Relative to its folder, so a data dir under a dot folder (~/.boxyard) isn't refused as a dotfile.
    res.sendFile(file.name, { root: file.folder })
  })
}
