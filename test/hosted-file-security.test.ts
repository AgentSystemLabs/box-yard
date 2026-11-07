import { afterAll, beforeAll, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { Artifacts } from "../server/artifacts.js"
import { Uploads, uploadsDir } from "../server/uploads.js"
import { HOSTED_CACHE_CONTROL, thumbsDir } from "../server/thumbs.js"
import { testConfig } from "./helpers.js"

// Only isolated files and a fake login; no agents, providers or background services are started.
const fixtures = [
  { filename: "drawing.svg", mime: "image/svg+xml", data: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>' },
  { filename: "demo.html", mime: "text/html; charset=utf-8", data: "<!doctype html><title>Demo</title><script>document.title = 'Ready'</script>" },
  { filename: "unknown.bin", mime: "application/octet-stream", data: "unknown file" },
  // An unreadable raster must retain the policy when thumbnail generation falls back to the original.
  { filename: "broken.png", mime: "image/png", data: "unreadable raster" },
]

describe("hosted file response security", () => {
  let yard: BoxYard
  let server: Server
  let base: string
  let cookie: string
  let artifacts: Artifacts
  let uploads: Uploads

  beforeAll(async () => {
    const config = testConfig({ password: "fake-hosted-file-password" })
    yard = createBoxYard(config, { webDir: path.join(config.dataDir, "no-web-build") })
    artifacts = new Artifacts(yard.store, path.join(config.dataDir, "artifacts"))
    uploads = new Uploads(uploadsDir(config.dataDir), 1024 * 1024)
    server = await new Promise<Server>((resolve) => {
      const s = yard.app.listen(0, "127.0.0.1", () => resolve(s))
    })
    const address = server.address() as { port: number }
    base = `http://127.0.0.1:${address.port}`
    const login = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: config.password }),
    })
    expect(login.status).toBe(200)
    cookie = login.headers.get("set-cookie")!.split(";")[0]!
    await login.arrayBuffer()
  })

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    yard?.stop()
  })

  function save(kind: "artifact" | "upload", filename: string, data: string) {
    if (kind === "artifact") {
      const artifact = artifacts.save({ title: "Fixture", filename, data: Buffer.from(data), projectId: null, taskId: null })
      return { url: artifact.url, path: yard.store.artifactPath(artifact.id)! }
    }
    const file = uploads.save(filename, Buffer.from(data))
    return { url: `/api/uploads/${file.id}/${file.name}`, path: file.path }
  }

  function expectPolicy(res: Response, kind: "artifact" | "upload", mime: string) {
    expect(res.status).toBe(200)
    expect(Object.fromEntries(res.headers)).toMatchObject({
      "content-type": mime,
      "x-content-type-options": "nosniff",
      "content-security-policy": kind === "artifact" ? "sandbox allow-scripts allow-forms allow-popups" : "sandbox",
      "cache-control": HOSTED_CACHE_CONTROL,
    })
    // A sandbox without allow-same-origin gives navigated documents an opaque origin.
    expect(res.headers.get("content-security-policy")).not.toContain("allow-same-origin")
  }

  for (const kind of ["artifact", "upload"] as const) {
    it.each(fixtures)(`${kind}: confines $filename on original/download, HEAD and thumbnail-fallback responses`, async ({ filename, mime, data }) => {
      const file = save(kind, filename, data)
      // Open original and <a download> use this same URL; no separate download endpoint exists.
      for (const suffix of ["", "?w=320", "?w=333"]) {
        const res = await fetch(base + file.url + suffix, { headers: { cookie } })
        expectPolicy(res, kind, mime)
        expect(await res.text()).toBe(data)
      }
      const head = await fetch(base + file.url, { method: "HEAD", headers: { cookie } })
      expectPolicy(head, kind, mime)
      expect(await head.text()).toBe("")
    })

    it(`${kind}: keeps the sandbox and nosniff on cached raster thumbnails`, async () => {
      const file = save(kind, "photo.png", "original fixture")
      fs.mkdirSync(thumbsDir(file.path), { recursive: true })
      // Seed the cache to exercise the thumbnail response without depending on optional sharp.
      fs.writeFileSync(path.join(thumbsDir(file.path), "320.webp"), "cached thumbnail fixture")
      const res = await fetch(`${base}${file.url}?w=320`, { headers: { cookie } })
      expectPolicy(res, kind, "image/webp")
      expect(await res.text()).toBe("cached thumbnail fixture")
    })
  }
})
