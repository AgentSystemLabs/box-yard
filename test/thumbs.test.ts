import { afterEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import express from "express"
import { HOSTED_CACHE_CONTROL, Thumbs, sendHosted, thumbWidth, thumbsDir, type Sharp } from "../server/thumbs.js"
import { Uploads } from "../server/uploads.js"
import { thumbUrl } from "../shared/thumbs.js"
import { freePort, tmpDir } from "./helpers.js"

type SharpModule = Sharp & {
  (options: { create: { width: number; height: number; channels: 3; background: string } }): {
    png(): { toBuffer(): Promise<Buffer> }
    jpeg(): { withMetadata(o: { orientation: number }): { toBuffer(): Promise<Buffer> } }
  }
  (input: Buffer | string): { metadata(): Promise<{ width: number; height: number; format: string }> }
}
const sharp: SharpModule | null = await import("sharp").then((m) => m.default as unknown as SharpModule).catch(() => null)

const noSharp = () => Promise.reject(new Error("Cannot find package 'sharp'"))

/** A real sharp that counts the images it opens. */
function counting() {
  const opened: string[] = []
  const load = async () => {
    const real = sharp!
    return ((input: string, options: { limitInputPixels: number }) => {
      opened.push(input)
      return real(input, options)
    }) as Sharp
  }
  return { opened, load }
}

async function png(dir: string, name: string, width: number, height: number) {
  const file = path.join(dir, name)
  fs.writeFileSync(file, await sharp!({ create: { width, height, channels: 3, background: "#3b82f6" } }).png().toBuffer())
  return file
}

describe("thumbnail URLs", () => {
  it("asks for a thumbnail of a hosted raster image only", () => {
    expect(thumbUrl("/artifacts/art_0123456789ab/shot.png", 320)).toBe("/artifacts/art_0123456789ab/shot.png?w=320")
    expect(thumbUrl("/api/uploads/up_0123456789ab/IMG_1001.JPG", 640)).toBe("/api/uploads/up_0123456789ab/IMG_1001.JPG?w=640")
    expect(thumbUrl("/artifacts/art_0123456789ab/my%20shot.webp", 1280)).toBe("/artifacts/art_0123456789ab/my%20shot.webp?w=1280")
    // Animations and vector images keep the original; so do other sites and URLs that already carry a query.
    for (const url of ["/artifacts/art_0123456789ab/spin.gif", "/artifacts/art_0123456789ab/logo.svg", "/artifacts/art_0123456789ab/report.pdf", "https://example.com/artifacts/a/b.png", "/artifacts/art_0123456789ab/a.png?x=1", "blob:http://localhost/1"])
      expect(thumbUrl(url, 320)).toBe(url)
  })

  it("only makes the listed widths, so the cache stays bounded", () => {
    expect(thumbWidth("320")).toBe(320)
    expect(thumbWidth("1280")).toBe(1280)
    for (const w of [undefined, "", "321", "4000", "0", "-320", "320px", ["320", "640"]]) expect(thumbWidth(w)).toBeNull()
  })
})

describe("Thumbs without sharp", () => {
  it("serves the original and says why once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const load = vi.fn(noSharp)
    const thumbs = new Thumbs(load)
    const file = path.join(tmpDir(), "shot.png")
    fs.writeFileSync(file, "not really a png")
    expect(await thumbs.get(file, "image/png", 320)).toBeNull()
    expect(await thumbs.get(file, "image/png", 640)).toBeNull()
    expect(load).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toMatch(/thumbnails are off.*sharp/)
    expect(fs.existsSync(thumbsDir(file))).toBe(false)
    warn.mockRestore()
  })

  it("doesn't load sharp for files it never shrinks", async () => {
    const load = vi.fn(noSharp)
    const thumbs = new Thumbs(load)
    expect(await thumbs.get("/x/spin.gif", "image/gif", 320)).toBeNull()
    expect(await thumbs.get("/x/report.pdf", "application/pdf", 320)).toBeNull()
    expect(await thumbs.get("/x/shot.png", "image/png", null)).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })
})

describe.skipIf(!sharp)("Thumbs with sharp", () => {
  it("makes a WebP at most the asked width beside the file, once", async () => {
    const dir = tmpDir()
    const file = await png(dir, "shot.png", 2000, 1000)
    const { opened, load } = counting()
    const thumbs = new Thumbs(load)
    // Two requests at once make one thumbnail.
    const [a, b] = await Promise.all([thumbs.get(file, "image/png", 320), thumbs.get(file, "image/png", 320)])
    expect(a).toBe(path.join(dir, "thumbs", "320.webp"))
    expect(b).toBe(a)
    expect(await sharp!(a!).metadata()).toMatchObject({ format: "webp", width: 320, height: 160 })
    expect(fs.statSync(a!).size).toBeLessThan(fs.statSync(file).size)
    // Later requests are served from disk.
    expect(await thumbs.get(file, "image/png", 320)).toBe(a)
    expect(opened).toEqual([file])
    // No leftover temp files.
    expect(fs.readdirSync(path.join(dir, "thumbs"))).toEqual(["320.webp"])
  })

  it("never enlarges a small image", async () => {
    const file = await png(tmpDir(), "icon.png", 64, 48)
    const out = await new Thumbs(counting().load).get(file, "image/png", 1280)
    expect(await sharp!(out!).metadata()).toMatchObject({ width: 64, height: 48 })
  })

  it("turns a phone photo the way its EXIF says", async () => {
    const file = path.join(tmpDir(), "IMG_1001.jpg")
    // Stored landscape, shown portrait (orientation 6: rotate 90°).
    fs.writeFileSync(file, await sharp!({ create: { width: 800, height: 400, channels: 3, background: "#16a34a" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer())
    const out = await new Thumbs(counting().load).get(file, "image/jpeg", 320)
    expect(await sharp!(out!).metadata()).toMatchObject({ width: 320, height: 640 })
  })

  it("serves the original for an image it can't read, without trying again", async () => {
    const file = path.join(tmpDir(), "broken.png")
    fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
    const { opened, load } = counting()
    const thumbs = new Thumbs(load)
    expect(await thumbs.get(file, "image/png", 320)).toBeNull()
    expect(await thumbs.get(file, "image/png", 640)).toBeNull()
    expect(opened).toHaveLength(1)
    expect(fs.existsSync(thumbsDir(file)) && fs.readdirSync(thumbsDir(file)).length).toBeFalsy()
  })

  it("keeps an upload's thumbnails out of the way of the upload itself", async () => {
    const uploads = new Uploads(tmpDir(), 10 * 1024 * 1024)
    const saved = uploads.save("shot.png", fs.readFileSync(await png(tmpDir(), "shot.png", 900, 600)))
    await new Thumbs(counting().load).get(saved.path, saved.mime, 320)
    expect(fs.existsSync(path.join(thumbsDir(saved.path), "320.webp"))).toBe(true)
    expect(uploads.get(saved.id)).toMatchObject({ name: "shot.png", path: saved.path, mime: "image/png" })
  })
})

describe("sendHosted", () => {
  let server: Server | null = null
  afterEach(async () => {
    await new Promise((res) => (server ? server.close(() => res(null)) : res(null)))
    server = null
  })

  async function serve(file: string, thumbs: Thumbs) {
    const app = express()
    app.get("/f", async (req, res) => {
      res.setHeader("Content-Type", "image/png")
      await sendHosted(req, res, { path: file, mime: "image/png" }, thumbs)
    })
    const port = await freePort()
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(port, "127.0.0.1", () => resolve(s))
    })
    return `http://127.0.0.1:${port}/f`
  }

  it.skipIf(!sharp)("sends the thumbnail for ?w= and the original otherwise, both kept by the browser", async () => {
    const file = await png(tmpDir(), "shot.png", 1600, 900)
    const url = await serve(file, new Thumbs(counting().load))
    const thumb = await fetch(`${url}?w=320`)
    expect(thumb.headers.get("content-type")).toBe("image/webp")
    expect(thumb.headers.get("cache-control")).toBe(HOSTED_CACHE_CONTROL)
    expect((await thumb.arrayBuffer()).byteLength).toBeLessThan(fs.statSync(file).size)
    const original = await fetch(url)
    expect(original.headers.get("content-type")).toBe("image/png")
    expect(original.headers.get("cache-control")).toBe(HOSTED_CACHE_CONTROL)
    expect(Buffer.from(await original.arrayBuffer()).equals(fs.readFileSync(file))).toBe(true)
    // A width that isn't offered gets the original.
    expect((await fetch(`${url}?w=333`)).headers.get("content-type")).toBe("image/png")
  })

  it("sends the original when sharp isn't installed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const file = path.join(tmpDir(), "shot.png")
    fs.writeFileSync(file, Buffer.from("original bytes"))
    const res = await fetch(`${await serve(file, new Thumbs(noSharp))}?w=320`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("image/png")
    expect(await res.text()).toBe("original bytes")
    warn.mockRestore()
  })

  it("serves a file under a dot folder, like a data dir in ~/.local/share, and a dot-named file", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const dir = path.join(tmpDir(), ".local", "share", "box-yard", "artifacts", "123-abc")
    fs.mkdirSync(dir, { recursive: true })
    for (const name of ["shot.png", ".hidden.png"]) {
      const file = path.join(dir, name)
      fs.writeFileSync(file, Buffer.from(`bytes of ${name}`))
      const url = await serve(file, new Thumbs(noSharp))
      for (const q of ["", "?w=320"]) {
        const res = await fetch(`${url}${q}`)
        expect(res.status, `${name}${q}`).toBe(200)
        expect(await res.text()).toBe(`bytes of ${name}`)
      }
      await new Promise((res) => server!.close(() => res(null)))
      server = null
    }
    warn.mockRestore()
  })

  it.skipIf(!sharp)("sends a thumbnail made beside a file under a dot folder", async () => {
    const dir = path.join(tmpDir(), ".local", "share", "box-yard")
    fs.mkdirSync(dir, { recursive: true })
    const file = await png(dir, "shot.png", 1600, 900)
    const thumb = await fetch(`${await serve(file, new Thumbs(counting().load))}?w=320`)
    expect(thumb.status).toBe(200)
    expect(thumb.headers.get("content-type")).toBe("image/webp")
    expect(fs.existsSync(path.join(thumbsDir(file), "320.webp"))).toBe(true)
  })
})
