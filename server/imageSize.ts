// An image's size as it's shown (a phone photo's EXIF orientation applied), read from the first bytes of a PNG, JPEG,
// GIF or WebP. Attachments carry it so a chat reserves an image's box before it loads, and nothing below it jumps.
import fs from "node:fs"

export interface ImageSize {
  width: number
  height: number
}

/** Enough for a phone JPEG's EXIF (with its embedded preview) before the frame header. */
const HEAD_BYTES = 128 * 1024

export function imageSizeOf(file: string): ImageSize | null {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, "r")
    const head = Buffer.alloc(HEAD_BYTES)
    return imageSize(head.subarray(0, fs.readSync(fd, head, 0, HEAD_BYTES, 0)))
  } catch {
    return null
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

export function imageSize(b: Buffer): ImageSize | null {
  try {
    const size = png(b) ?? gif(b) ?? webp(b) ?? jpeg(b)
    return size && size.width > 0 && size.height > 0 ? size : null
  } catch {
    // A file cut short or lying about its lengths.
    return null
  }
}

function png(b: Buffer): ImageSize | null {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.toString("latin1", 12, 16) !== "IHDR") return null
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

function gif(b: Buffer): ImageSize | null {
  if (b.length < 10 || !/^GIF8[79]a$/.test(b.toString("latin1", 0, 6))) return null
  return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) }
}

function webp(b: Buffer): ImageSize | null {
  if (b.length < 30 || b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WEBP") return null
  const chunk = b.toString("latin1", 12, 16)
  if (chunk === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
  if (chunk === "VP8L") {
    const bits = b.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  if (chunk === "VP8X") return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 }
  return null
}

/** Start-of-frame markers: every JPEG coding but the DHT (C4), JPG (C8) and DAC (CC) look-alikes. */
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

function jpeg(b: Buffer): ImageSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  let orientation = 1
  let i = 2
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null
    const marker = b[i + 1]!
    // Fill bytes, and markers without a length.
    if (marker === 0xff) {
      i++
      continue
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2
      continue
    }
    const end = i + 2 + b.readUInt16BE(i + 2)
    if (marker === 0xe1 && b.toString("latin1", i + 4, i + 10) === "Exif\0\0") orientation = exifOrientation(b, i + 10, Math.min(end, b.length)) ?? orientation
    if (SOF.has(marker)) {
      const height = b.readUInt16BE(i + 5)
      const width = b.readUInt16BE(i + 7)
      // Orientations 5 to 8 turn the picture a quarter, which swaps its sides on screen.
      return orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height }
    }
    i = end
  }
  return null
}

/** The Orientation tag (0x0112) of EXIF data whose TIFF header starts at `tiff`. */
function exifOrientation(b: Buffer, tiff: number, end: number): number | null {
  if (tiff + 8 > end) return null
  const le = b.toString("latin1", tiff, tiff + 2) === "II"
  const u16 = (at: number) => (le ? b.readUInt16LE(at) : b.readUInt16BE(at))
  const u32 = (at: number) => (le ? b.readUInt32LE(at) : b.readUInt32BE(at))
  const ifd = tiff + u32(tiff + 4)
  if (ifd + 2 > end) return null
  for (let k = 0, n = u16(ifd); k < n; k++) {
    const entry = ifd + 2 + k * 12
    if (entry + 12 > end) return null
    if (u16(entry) === 0x0112) return u16(entry + 8)
  }
  return null
}
