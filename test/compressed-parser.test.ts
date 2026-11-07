import { fork } from "node:child_process"
import { once } from "node:events"
import http from "node:http"
import { setTimeout as delay } from "node:timers/promises"
import { gzipSync } from "node:zlib"
import { describe, expect, it } from "vitest"

describe("compressed request parser process safety", () => {
  for (const kind of ["json", "text", "raw"] as const) {
    it(`${kind} survives late malformed bytes and serves a subsequent compressed request`, async () => {
      // The only destination is this fresh child listening on an OS-assigned loopback port.
      // Do not install uncaughtException/error handlers in the child: a decoder crash must fail.
      const child = fork(new URL("./fixtures/compressed-parser.mjs", import.meta.url), [kind], {
        env: { NODE_ENV: "test" }, execArgv: [], silent: true,
      })
      let stderr = ""
      child.stderr!.on("data", (data) => { stderr += data })
      const exited = once(child, "exit")
      const crashed = exited.then(([code, signal]) => {
        throw new Error(`Parser child exited (${code ?? signal}): ${stderr}`)
      })
      // Register rejection handling immediately, including while waiting for the listen message.
      void crashed.catch(() => {})
      const requests: http.ClientRequest[] = []
      try {
        const [ready] = await Promise.race([once(child, "message"), crashed])
        const port = (ready as { port: number }).port
        expect(port).toBeGreaterThan(0)
        const contentType = kind === "json" ? "application/json" : "application/octet-stream"
        const payload = '{"fixture":"only"}'
        const frame = Buffer.concat([gzipSync(payload), Buffer.from([0])])
        const trailing = Buffer.alloc(128 * 1024, 0x58)
        const parsed = once(child, "message")
        const bad = http.request({
          hostname: "127.0.0.1", port, method: "POST", path: "/unmatched", agent: false,
          headers: {
            "Content-Type": contentType, "Content-Encoding": "gzip",
            "Content-Length": frame.length + trailing.length,
          },
        })
        requests.push(bad)
        const rejected = new Promise<number | undefined>((resolve, reject) => {
          bad.on("error", reject)
          bad.on("response", (res) => {
            res.on("error", reject)
            res.resume()
            res.on("end", () => resolve(res.statusCode))
          })
        })
        bad.setTimeout(5000, () => bad.destroy(new Error("Malformed request timed out")))
        void rejected.catch(() => {})
        bad.write(frame)
        const [notification] = await Promise.race([parsed, rejected, crashed]) as [{ parsed: boolean }]
        expect(notification.parsed).toBe(true)
        bad.end(trailing)
        expect(await Promise.race([rejected, crashed])).toBe(401)

        // Valid gzip must still work, including the JSON verify buffer used for signatures.
        const good = http.request({
          hostname: "127.0.0.1", port, method: "POST", path: "/echo", agent: false,
          headers: {
            "Content-Type": contentType, "Content-Encoding": "gzip",
            Authorization: "Bearer fixture-token",
          },
        })
        requests.push(good)
        const response = new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
          good.on("error", reject)
          good.on("response", (res) => {
            let body = ""
            res.setEncoding("utf8")
            res.on("data", (chunk) => { body += chunk })
            res.on("error", reject)
            res.on("end", () => resolve({ status: res.statusCode, body }))
          })
        })
        good.setTimeout(5000, () => good.destroy(new Error("Follow-up request timed out")))
        good.end(gzipSync(payload))
        const result = await Promise.race([response, crashed])
        expect(result.status).toBe(200)
        expect(JSON.parse(result.body)).toEqual(kind === "json"
          ? { body: JSON.parse(payload), rawBody: payload }
          : { body: payload })
        expect(child.exitCode).toBeNull()
      } catch (error) {
        // Socket closure can arrive just before the child's exit event; retain the crash cause.
        await Promise.race([exited, delay(200)])
        if (child.exitCode !== null) throw new Error(`Parser child exited (${child.exitCode}): ${stderr}`)
        throw error
      } finally {
        for (const req of requests) req.destroy()
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
        await exited
      }
    }, 15_000)
  }
})
