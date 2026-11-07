// @vitest-environment happy-dom
import { expect, it } from "vitest"
import http from "node:http"

it("renders iframe, image and script fixtures without requesting their URLs", async () => {
  let requests = 0
  const server = http.createServer((_req, res) => {
    requests++
    res.end("fixture must not load")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port
  const nodes = [document.createElement("iframe"), document.createElement("img"), document.createElement("script")]
  try {
    expect(window.location.hostname).toBe("boxyard.invalid")
    for (const node of nodes) {
      node.src = `http://127.0.0.1:${port}/artifacts/fixture`
      document.body.append(node)
    }
    await (window as unknown as { happyDOM: { waitUntilComplete(): Promise<void> } }).happyDOM.waitUntilComplete()
    expect(requests).toBe(0)
  } finally {
    for (const node of nodes) node.remove()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
