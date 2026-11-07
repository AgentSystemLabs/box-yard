import { afterEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import { ICON_MAX_UNSHRUNK, ICON_SIZE, ProjectIcons, projectIconRoutes, projectIconsDir, sniffIcon } from "../server/projectIcons.js"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import type { Sharp } from "../server/thumbs.js"
import { imageSize } from "../server/imageSize.js"
import { PROJECT_ICON_MAX_BYTES, projectIconUrl } from "../shared/projectIcons.js"
import type { UiEvent } from "../shared/types.js"
import { freePort, tmpDir } from "./helpers.js"

// A project's own icon (Project settings › General › Icon): checked by its bytes, shrunk, stored in the data dir,
// served sandboxed with its hash in the URL, and taken off again.

type SharpModule = Sharp & ((options: { create: { width: number; height: number; channels: 4; background: string } }) => { png(): { toBuffer(): Promise<Buffer> }; gif(): { toBuffer(): Promise<Buffer> } })
const sharp: SharpModule | null = await import("sharp").then((m) => m.default as unknown as SharpModule).catch(() => null)
const noSharp = () => Promise.reject(new Error("Cannot find package 'sharp'"))

/** A PNG header that says `width` × `height`: enough for the size check, not to decode. */
function pngHead(width: number, height: number) {
  const b = Buffer.alloc(33)
  b.writeUInt32BE(0x89504e47, 0)
  b.writeUInt32BE(0x0d0a1a0a, 4)
  b.writeUInt32BE(13, 8)
  b.write("IHDR", 12, "latin1")
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  b[24] = 8
  b[25] = 6
  return b
}

const realPng = (width: number, height: number) => sharp!({ create: { width, height, channels: 4, background: "#f472b6" } }).png().toBuffer()

const SVG = Buffer.from('<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><rect width="10" height="10"/></svg>')

describe("sniffIcon", () => {
  it("reads the type from the bytes", () => {
    expect(sniffIcon(pngHead(10, 10))).toBe("png")
    expect(sniffIcon(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]))).toBe("jpeg")
    expect(sniffIcon(Buffer.from("GIF89a\x01\x00\x01\x00", "latin1"))).toBe("gif")
    expect(sniffIcon(Buffer.from("RIFF\x24\x00\x00\x00WEBPVP8 ", "latin1"))).toBe("webp")
    expect(sniffIcon(SVG)).toBe("svg")
    expect(sniffIcon(Buffer.from('﻿<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">\n<svg/>'))).toBe("svg")
    expect(sniffIcon(Buffer.from("  <svg>\n</svg>"))).toBe("svg")
  })

  it("refuses anything else, whatever it's called", () => {
    for (const text of ["<html><svg></svg></html>", "<svgfoo/>", "hello", "%PDF-1.7", "{}", "<!-- <svg> -->"]) expect(sniffIcon(Buffer.from(text))).toBeNull()
    expect(sniffIcon(Buffer.from("<svg>\0</svg>"))).toBeNull()
    expect(sniffIcon(Buffer.alloc(0))).toBeNull()
    expect(sniffIcon(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull()
  })
})

describe("ProjectIcons", () => {
  const icons = (load?: () => Promise<Sharp>) => new ProjectIcons(projectIconsDir(tmpDir()), load)

  it("keeps a small image as it is, named by its hash", async () => {
    const pi = icons(noSharp)
    const data = pngHead(64, 64)
    const name = await pi.save("prj_demo01", data)
    expect(name).toMatch(/^[a-f0-9]{12}\.png$/)
    const file = pi.file("prj_demo01", name)!
    expect(file.mime).toBe("image/png")
    expect(fs.readFileSync(path.join(file.folder, file.name))).toEqual(data)
    // The same bytes get the same name; other bytes another.
    expect(await pi.save("prj_demo01", data)).toBe(name)
    expect(await pi.save("prj_demo01", pngHead(32, 32))).not.toBe(name)
  })

  it("keeps an SVG as it is", async () => {
    const pi = icons(noSharp)
    const name = await pi.save("prj_demo01", SVG)
    expect(name).toMatch(/\.svg$/)
    expect(pi.file("prj_demo01", name)!.mime).toBe("image/svg+xml")
  })

  it.skipIf(!sharp)("shrinks a large raster to a square icon", async () => {
    const pi = icons()
    const name = await pi.save("prj_demo01", await realPng(1200, 600))
    expect(name).toMatch(/\.webp$/)
    const file = pi.file("prj_demo01", name)!
    expect(imageSize(fs.readFileSync(path.join(file.folder, file.name)))).toEqual({ width: ICON_SIZE, height: ICON_SIZE })
  })

  it("without sharp, keeps a mid-sized raster and refuses a large one with why", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const pi = icons(noSharp)
    expect(await pi.save("prj_demo01", pngHead(ICON_MAX_UNSHRUNK, 500))).toMatch(/\.png$/)
    await expect(pi.save("prj_demo01", pngHead(4032, 3024))).rejects.toThrow(/4032 × 3024 px.*sharp isn't installed.*1024 px/)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it("refuses empty, oversized, unknown and broken files", async () => {
    const pi = icons(noSharp)
    await expect(pi.save("prj_demo01", Buffer.alloc(0))).rejects.toThrow(/empty/)
    const big = Buffer.concat([pngHead(10, 10), Buffer.alloc(PROJECT_ICON_MAX_BYTES)])
    await expect(pi.save("prj_demo01", big)).rejects.toMatchObject({ status: 413, message: expect.stringMatching(/up to 1 MB/) })
    await expect(pi.save("prj_demo01", Buffer.from("<html>hi</html>"))).rejects.toThrow(/PNG, JPG, WebP, GIF or SVG/)
    await expect(pi.save("prj_demo01", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]))).rejects.toThrow(/PNG couldn't be read/)
    expect(fs.existsSync(path.join(pi.dir, "prj_demo01"))).toBe(false)
  })

  it.skipIf(!sharp)("refuses a large raster sharp can't decode", async () => {
    const pi = icons()
    await expect(pi.save("prj_demo01", Buffer.concat([pngHead(2000, 2000), Buffer.from("garbage")]))).rejects.toThrow(/PNG couldn't be read/)
  })

  it("prunes the files the project no longer uses, and all of them when it has none", async () => {
    const pi = icons(noSharp)
    const a = await pi.save("prj_demo01", pngHead(10, 10))
    const b = await pi.save("prj_demo01", pngHead(20, 20))
    pi.prune("prj_demo01", b)
    expect(pi.file("prj_demo01", a)).toBeNull()
    expect(pi.file("prj_demo01", b)).not.toBeNull()
    pi.prune("prj_demo01")
    expect(fs.existsSync(path.join(pi.dir, "prj_demo01"))).toBe(false)
  })

  it("never reaches outside its folder", async () => {
    const pi = icons(noSharp)
    expect(pi.file("prj_demo01", "../../box-yard.sqlite")).toBeNull()
    await expect(pi.save("../x", pngHead(10, 10))).rejects.toThrow(/Bad project id/)
  })
})

describe("icon routes", () => {
  const servers: Server[] = []
  afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise((r) => s.close(r))
  })

  async function start(load: () => Promise<Sharp> = noSharp) {
    const dir = tmpDir()
    const store = new Store(openDb(dir))
    const icons = new ProjectIcons(projectIconsDir(dir), load)
    const events: UiEvent[] = []
    const api = express.Router()
    projectIconRoutes(api, { store, icons, hub: { broadcast: (e) => void events.push(e) } })
    const app = express()
    app.use("/api", api)
    app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => void res.status(err.status ?? 500).json({ error: err.message }))
    const port = await freePort()
    servers.push(await new Promise<Server>((resolve) => { const s = app.listen(port, "127.0.0.1", () => resolve(s)) }))
    const project = store.createProject({ id: "prj_demo01", name: "Demo" })
    return { base: `http://127.0.0.1:${port}`, store, icons, events, project }
  }

  const put = (base: string, body: Buffer, type = "application/octet-stream") => fetch(`${base}/api/projects/prj_demo01/icon`, { method: "PUT", body, headers: { "Content-Type": type } })

  it("sets an icon, serves it sandboxed by its sniffed type, and tells open tabs", async () => {
    const { base, store, events, project } = await start()
    expect(project.iconUrl).toBeNull()
    const data = pngHead(48, 48)
    // Sent as something else: the bytes decide.
    const res = await put(base, data, "image/svg+xml")
    expect(res.status).toBe(200)
    const saved = await res.json()
    expect(saved.iconUrl).toMatch(/^\/api\/projects\/prj_demo01\/icon\?v=[a-f0-9]{12}$/)
    expect(store.getProject("prj_demo01")!.iconUrl).toBe(saved.iconUrl)
    expect(events).toEqual([{ type: "project", project: saved }])

    const got = await fetch(`${base}${saved.iconUrl}`)
    expect(got.status).toBe(200)
    expect(got.headers.get("content-type")).toBe("image/png")
    expect(got.headers.get("x-content-type-options")).toBe("nosniff")
    expect(got.headers.get("content-security-policy")).toMatch(/\bsandbox\b/)
    expect(got.headers.get("cache-control")).toMatch(/immutable/)
    expect(Buffer.from(await got.arrayBuffer())).toEqual(data)
    // Without the current version in the URL, the browser checks each time.
    expect((await fetch(`${base}/api/projects/prj_demo01/icon?v=000000000000`)).headers.get("cache-control")).toBe("no-cache")
  })

  it("serves an SVG as an image that can't run scripts", async () => {
    const { base } = await start()
    const { iconUrl } = await (await put(base, SVG)).json()
    const got = await fetch(`${base}${iconUrl}`)
    expect(got.headers.get("content-type")).toMatch(/^image\/svg\+xml/)
    expect(got.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox")
  })

  it("replaces an icon with a new URL and drops the old file", async () => {
    const { base, icons } = await start()
    const first = (await (await put(base, pngHead(10, 10))).json()).iconUrl as string
    const second = (await (await put(base, pngHead(20, 20))).json()).iconUrl as string
    expect(second).not.toBe(first)
    expect(fs.readdirSync(path.join(icons.dir, "prj_demo01"))).toHaveLength(1)
  })

  it.skipIf(!sharp)("shrinks a large upload", async () => {
    const { base } = await start(async () => sharp!)
    const { iconUrl } = await (await put(base, await realPng(900, 900))).json()
    const got = await fetch(`${base}${iconUrl}`)
    expect(got.headers.get("content-type")).toBe("image/webp")
    expect(imageSize(Buffer.from(await got.arrayBuffer()))).toEqual({ width: ICON_SIZE, height: ICON_SIZE })
  })

  it("refuses a file that isn't an icon and keeps the one it had", async () => {
    const { base, store, events } = await start()
    const { iconUrl } = await (await put(base, pngHead(10, 10))).json()
    const bad = await put(base, Buffer.from("#!/bin/sh\necho hi\n"), "image/png")
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toMatch(/isn't an image an icon can be/)
    const big = await put(base, Buffer.concat([pngHead(10, 10), Buffer.alloc(PROJECT_ICON_MAX_BYTES)]))
    expect(big.status).toBe(413)
    expect((await big.json()).error).toMatch(/an icon can be up to 1 MB/)
    expect(store.getProject("prj_demo01")!.iconUrl).toBe(iconUrl)
    expect(events).toHaveLength(1)
  })

  it("removes an icon: back to the letter, and nothing left to serve", async () => {
    const { base, store, icons, events } = await start()
    const { iconUrl } = await (await put(base, pngHead(10, 10))).json()
    const res = await fetch(`${base}/api/projects/prj_demo01/icon`, { method: "DELETE" })
    expect(res.status).toBe(200)
    expect((await res.json()).iconUrl).toBeNull()
    expect(store.getProject("prj_demo01")!.iconUrl).toBeNull()
    expect(events.at(-1)).toMatchObject({ type: "project", project: { id: "prj_demo01", iconUrl: null } })
    expect(fs.existsSync(path.join(icons.dir, "prj_demo01"))).toBe(false)
    expect((await fetch(`${base}${iconUrl}`)).status).toBe(404)
  })

  it("answers 404 for a project that isn't there", async () => {
    const { base } = await start()
    expect((await fetch(`${base}/api/projects/prj_nope01/icon`, { method: "PUT", body: pngHead(10, 10) })).status).toBe(404)
    expect((await fetch(`${base}/api/projects/prj_nope01/icon`, { method: "DELETE" })).status).toBe(404)
    expect((await fetch(`${base}/api/projects/prj_nope01/icon`)).status).toBe(404)
  })

  it("names the hash in the URL", () => {
    expect(projectIconUrl("prj_demo01", "0123456789ab.webp")).toBe("/api/projects/prj_demo01/icon?v=0123456789ab")
  })
})
