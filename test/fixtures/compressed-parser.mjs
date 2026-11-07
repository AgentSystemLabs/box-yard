import express from "express"

// Isolated dependency fixture: no application startup, data store or provider access.
const kind = process.argv[2]
const app = express()
if (kind === "json") {
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString("utf8") } }))
} else if (kind === "text" || kind === "raw") {
  app.use(express[kind]({ type: () => true }))
} else {
  throw new Error("Unknown parser fixture")
}

app.use((req, res, next) => {
  // Synchronize the late input with parser completion instead of relying on a timer.
  if (req.path === "/unmatched") process.send({ parsed: true })
  if (req.headers.authorization !== "Bearer fixture-token") {
    // Wait for the complete HTTP body, including bytes arriving after decoding ends.
    req.on("end", () => res.sendStatus(401))
    return
  }
  next()
})
app.post("/echo", (req, res) => res.json({
  body: Buffer.isBuffer(req.body) ? req.body.toString("utf8") : req.body,
  rawBody: req.rawBody,
}))
app.use((err, _req, res, _next) => res.sendStatus(err.status || 500))

const server = app.listen(0, "127.0.0.1", () => process.send({ port: server.address().port }))
process.on("disconnect", () => {
  server.closeAllConnections()
  server.close()
})
