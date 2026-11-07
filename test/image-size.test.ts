import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { imageSize, imageSizeOf } from "../server/imageSize.js"
import { Uploads } from "../server/uploads.js"
import { tmpDir } from "./helpers.js"

type Img = { png(): Img; jpeg(): Img; webp(o?: { lossless?: boolean }): Img; withMetadata(o: { orientation: number }): Img; toBuffer(): Promise<Buffer> }
type MakeImage = (o: { create: { width: number; height: number; channels: 3 | 4; background: string } }) => Img
const sharp: MakeImage | null = await import("sharp").then((m) => m.default as unknown as MakeImage).catch(() => null)
const blank = (width: number, height: number, channels: 3 | 4 = 3) => sharp!({ create: { width, height, channels, background: channels === 4 ? "#3b82f680" : "#3b82f6" } })

/** The first bytes of a PNG: signature and IHDR. */
function pngHead(width: number, height: number) {
  const b = Buffer.alloc(33)
  b.writeUInt32BE(0x89504e47, 0)
  b.writeUInt32BE(0x0d0a1a0a, 4)
  b.writeUInt32BE(13, 8)
  b.write("IHDR", 12, "latin1")
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}

describe("imageSize", () => {
  it("reads a PNG and a GIF from their headers", () => {
    expect(imageSize(pngHead(1440, 900))).toEqual({ width: 1440, height: 900 })
    const gif = Buffer.from("GIF89a\x40\x01\xf0\x00", "latin1")
    expect(imageSize(gif)).toEqual({ width: 320, height: 240 })
  })

  it("gives up on anything else, or a header cut short", () => {
    expect(imageSize(Buffer.from("hello world, not an image at all"))).toBeNull()
    expect(imageSize(pngHead(1440, 900).subarray(0, 20))).toBeNull()
    expect(imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a]))).toBeNull()
    expect(imageSize(Buffer.alloc(0))).toBeNull()
    expect(imageSize(pngHead(0, 900))).toBeNull()
  })

  it.skipIf(!sharp)("reads a JPEG, and turns it the way its EXIF says", async () => {
    expect(imageSize(await blank(800, 400).jpeg().toBuffer())).toEqual({ width: 800, height: 400 })
    // A phone photo stored landscape and shown portrait (orientation 6), and one shown upside down (3).
    expect(imageSize(await blank(800, 400).jpeg().withMetadata({ orientation: 6 }).toBuffer())).toEqual({ width: 400, height: 800 })
    expect(imageSize(await blank(800, 400).jpeg().withMetadata({ orientation: 3 }).toBuffer())).toEqual({ width: 800, height: 400 })
  })

  it.skipIf(!sharp)("reads lossy, lossless and extended WebP", async () => {
    expect(imageSize(await blank(640, 360).webp().toBuffer())).toEqual({ width: 640, height: 360 })
    expect(imageSize(await blank(641, 361).webp({ lossless: true }).toBuffer())).toEqual({ width: 641, height: 361 })
    expect(imageSize(await blank(300, 200, 4).webp().toBuffer())).toEqual({ width: 300, height: 200 })
  })

  it("reads a file's head, and returns null for a missing file", () => {
    const file = path.join(tmpDir(), "shot.png")
    fs.writeFileSync(file, Buffer.concat([pngHead(1280, 720), Buffer.alloc(200_000)]))
    expect(imageSizeOf(file)).toEqual({ width: 1280, height: 720 })
    expect(imageSizeOf(path.join(tmpDir(), "missing.png"))).toBeNull()
  })
})

describe("uploads carry an image's size", () => {
  it("when saved and when looked up again, and only for images", () => {
    const uploads = new Uploads(tmpDir(), 1024 * 1024)
    const shot = uploads.save("shot.png", Buffer.concat([pngHead(1440, 900), Buffer.alloc(64)]))
    expect(shot).toMatchObject({ width: 1440, height: 900 })
    expect(uploads.get(shot.id)).toMatchObject({ name: "shot.png", width: 1440, height: 900 })
    const notes = uploads.save("notes.txt", Buffer.from("plain text"))
    expect(notes).not.toHaveProperty("width")
    expect(uploads.get(notes.id)).not.toHaveProperty("width")
    // An image the server can't read still uploads, without a size.
    const odd = uploads.save("odd.png", Buffer.from("not a png"))
    expect(uploads.get(odd.id)).toMatchObject({ name: "odd.png", mime: "image/png" })
    expect(uploads.get(odd.id)).not.toHaveProperty("width")
  })
})
