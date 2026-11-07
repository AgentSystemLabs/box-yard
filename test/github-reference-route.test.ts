import { afterEach, expect, it } from "vitest"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { freePort, testConfig, tmpDir } from "./helpers.js"

let yard: BoxYard | undefined
let server: Server | undefined
afterEach(async () => {
  yard?.stop()
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
})

it("resolves the repository and credentials from the requested project and rejects invalid requests", async () => {
  const calls: { url: string; token: string }[] = []
  const port = await freePort()
  yard = createBoxYard(testConfig({ port }), { webDir: "/nonexistent", machines: { keys: { home: tmpDir() } }, github: {
    token: (id) => `token-for-${id}`,
    fetch: (async (url, init) => {
      calls.push({ url: String(url), token: String((init?.headers as Record<string, string>).Authorization) })
      return new Response("[]")
    }) as typeof fetch,
  } })
  server = await new Promise<Server>((resolve) => { const s = yard!.app.listen(port, "127.0.0.1", () => resolve(s)) })
  const site = yard.store.createProject({ name: "Site", repo: "https://github.com/acme/site" })
  const other = yard.store.createProject({ name: "Other", repo: "https://github.com/acme/other" })
  const empty = yard.store.createProject({ name: "Empty" })
  const get = (id: string, q = "") => fetch(`http://127.0.0.1:${port}/api/projects/${id}/github-references${q}`)
  expect((await get(site.id)).status).toBe(200)
  expect((await get(other.id)).status).toBe(200)
  expect(calls).toEqual([
    { url: "https://api.github.com/repos/acme/site/issues?state=all&sort=updated&direction=desc&per_page=20", token: `Bearer token-for-${site.id}` },
    { url: "https://api.github.com/repos/acme/other/issues?state=all&sort=updated&direction=desc&per_page=20", token: `Bearer token-for-${other.id}` },
  ])
  expect((await get("prj_missing")).status).toBe(404)
  expect((await get(site.id, "?q=a&q=b")).status).toBe(400)
  expect((await get(site.id, `?q=${"x".repeat(121)}`)).status).toBe(400)
  expect(await (await get(empty.id)).json()).toMatchObject({ repo: null, items: [], problem: "This project has no GitHub repository." })
  expect(calls).toHaveLength(2)
})
