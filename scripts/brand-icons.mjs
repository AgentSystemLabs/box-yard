#!/usr/bin/env node
// Draw every app icon from the one logo, web/public/icons/box-yard-icon.svg:
//
//   node scripts/brand-icons.mjs        (needs rsvg-convert: brew install librsvg / apt install librsvg2-bin)
//
// favicon.svg is the logo itself: the Y-brace crate, edge to edge with an empty Y-shaped gap, so it's as large as it can
// be in a 16px tab. The tab and notification PNGs and the manifest's "any" ones keep it as drawn, on transparency. Where a
// platform masks the icon (iOS's apple-touch-icon, the manifest's "maskable" ones) it sits on an opaque near-black tile,
// shrunk so the mask never clips it; the maskable crate fits the 80% safe circle. favicon.ico packs the 16, 32 and 48 px
// PNGs.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const pub = new URL("../web/public/", import.meta.url).pathname
const logo = fs.readFileSync(path.join(pub, "icons/box-yard-icon.svg"), "utf8")
if (!logo.includes('viewBox="0 0 256 256"')) throw new Error("box-yard-icon.svg must be drawn on a 256 viewBox")
const TILE = "#09090b"
// The crate's rounded corners reach 152 units from the centre, 59% of the icon's width; the maskable icons shrink that
// inside the safe circle's radius (40% of the width), and iOS's icon gets a near-black margin around the crate.
const MASKABLE_SCALE = 0.66
const APPLE_SCALE = 0.72

const inner = logo.slice(logo.indexOf(">", logo.indexOf("<svg")) + 1, logo.lastIndexOf("</svg>"))
const filled = (scale) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" fill="${TILE}"/>` +
  `<g transform="translate(128 128) scale(${scale}) translate(-128 -128)">${inner}</g></svg>`

function png(svg, size, file) {
  const data = execFileSync("rsvg-convert", ["-w", String(size), "-h", String(size)], { input: svg })
  if (file) fs.writeFileSync(path.join(pub, file), data)
  return data
}

/** An .ico of PNG frames, which every browser since IE 11 reads. */
function ico(frames) {
  const head = Buffer.alloc(6 + 16 * frames.length)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(frames.length, 4)
  let offset = head.length
  frames.forEach(({ size, data }, i) => {
    const at = 6 + 16 * i
    head.writeUInt8(size % 256, at)
    head.writeUInt8(size % 256, at + 1)
    head.writeUInt16LE(1, at + 4)
    head.writeUInt16LE(32, at + 6)
    head.writeUInt32LE(data.length, at + 8)
    head.writeUInt32LE(offset, at + 12)
    offset += data.length
  })
  return Buffer.concat([head, ...frames.map((f) => f.data)])
}

fs.writeFileSync(path.join(pub, "favicon.svg"), logo)
const frames = [16, 32, 48].map((size) => ({ size, data: png(logo, size, `favicon-${size}x${size}.png`) }))
fs.writeFileSync(path.join(pub, "favicon.ico"), ico(frames))
png(filled(APPLE_SCALE), 180, "apple-touch-icon.png")
for (const size of [192, 512]) {
  png(logo, size, `icons/box-yard-${size}.png`)
  png(filled(MASKABLE_SCALE), size, `icons/box-yard-maskable-${size}.png`)
}
console.log("wrote favicon.svg, favicon.ico, favicon-{16,32,48}x*.png, apple-touch-icon.png, icons/box-yard-{,maskable-}{192,512}.png")
