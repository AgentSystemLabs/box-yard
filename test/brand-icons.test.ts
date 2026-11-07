import fs from "node:fs"
import path from "node:path"
import { createElement, Fragment } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { BrandLogo } from "../web/src/components/BrandLogo.js"

// The app's icons are one logo (web/public/icons/box-yard-icon.svg), drawn by scripts/brand-icons.mjs: every icon the
// page and the manifest name exists at the size it claims, the ones a platform masks are opaque, and the Y of the
// sidebar's wordmark is the same Y-brace crate.

const pub = path.join(import.meta.dirname, "../web/public")
const read = (file: string) => fs.readFileSync(path.join(pub, file))
const logo = read("icons/box-yard-icon.svg").toString()

/** A PNG's width, height and colour type, from its IHDR chunk. */
function png(file: string) {
  const data = read(file)
  expect(data.subarray(1, 4).toString(), file).toBe("PNG")
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), alpha: data[25] === 4 || data[25] === 6 }
}

describe("brand icons", () => {
  it("serve one self-contained logo as the favicon and the app icon", () => {
    expect(read("favicon.svg").toString()).toBe(logo)
    // Nothing outside the file: no linked image, font, stylesheet or script.
    expect(logo).not.toMatch(/href=|<image|<script|<style|@import|url\(/)
    expect(logo).toContain('viewBox="0 0 256 256"')
  })

  it("name only icons that exist, at the sizes they claim", () => {
    const html = fs.readFileSync(path.join(pub, "../index.html"), "utf8")
    const links = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon)"[^>]*>/g)].map((m) => m[0])
    expect(links.length).toBeGreaterThanOrEqual(5)
    for (const link of links) {
      const href = link.match(/href="\/([^"]+)"/)![1]
      const sizes = link.match(/sizes="(\d+)x\d+"/)?.[1]
      if (sizes) expect(png(href), href).toMatchObject({ width: Number(sizes), height: Number(sizes) })
      else expect(fs.existsSync(path.join(pub, href)), href).toBe(true)
    }
    const manifest = JSON.parse(read("manifest.webmanifest").toString()) as { icons: { src: string; sizes: string; purpose: string }[] }
    for (const icon of manifest.icons) {
      const file = icon.src.slice(1)
      if (icon.sizes === "any") {
        expect(file).toBe("icons/box-yard-icon.svg")
        // Its crate reaches past the maskable safe circle: the maskable PNGs cover that.
        expect(icon.purpose).toBe("any")
        continue
      }
      const size = Number(icon.sizes.split("x")[0])
      expect(png(file), file).toMatchObject({ width: size, height: size })
      if (icon.purpose === "maskable") expect(png(file).alpha, `${file} is opaque`).toBe(false)
    }
    // iOS fills a transparent apple-touch-icon with black.
    expect(png("apple-touch-icon.png").alpha).toBe(false)
  })

  it("pack the 16, 32 and 48 px PNGs into favicon.ico", () => {
    const ico = read("favicon.ico")
    expect(ico.readUInt16LE(2)).toBe(1)
    const frames = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => {
      const at = 6 + 16 * i
      const offset = ico.readUInt32LE(at + 12)
      return { size: ico[at], png: ico.subarray(offset + 1, offset + 4).toString() }
    })
    expect(frames).toEqual([16, 32, 48].map((size) => ({ size, png: "PNG" })))
  })

  it("draw the wordmark's Y as the logo's crate, with nothing two copies could share", () => {
    const fills = (svg: string) => [...svg.matchAll(/<path d="[^"]+" fill="([^"]+)"/g)].map((m) => m[1])
    // A light top, an amber plank and a dark plank, in the logo's order; the Y between them is empty, not painted.
    expect(fills(logo)).toEqual(["#fcd34d", "#f59e0b", "#b45309"])
    const html = renderToStaticMarkup(createElement(Fragment, null, createElement(BrandLogo), createElement(BrandLogo)))
    expect(fills(html)).toEqual([...fills(logo), ...fills(logo)])
    expect(html.match(/<svg [^>]*viewBox="0 0 730 730"/g)).toHaveLength(2)
    // No ids (clip paths, gradients): several logos on one page can't pick up each other's. The corners are a CSS inset.
    expect(html).not.toMatch(/ id=|url\(#/)
    // There's no separate mark: the wordmark is the logo, and a screen reader hears its name, not "BOX ARD".
    expect(html.match(/<svg /g)).toHaveLength(2)
    expect(html.match(/<span class="sr-only">([^<]*)<\/span>/g)).toEqual(Array(2).fill('<span class="sr-only">Box Yard</span>'))
    const shown = [...html.matchAll(/<span aria-hidden="true"[^>]*>(.*?)<\/span>/g)].map((m) => m[1].replace(/<svg.*?<\/svg>/, "Y"))
    expect(shown).toEqual(["BOX YARD", "BOX YARD"])
  })
})
