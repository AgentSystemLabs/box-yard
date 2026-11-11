#!/usr/bin/env node
// `npx github:AgentSystemLabs/box-yard`: install Box Yard on first run, then start it (launcher/main.mjs, docs/npx.md).
// This file only checks Node's version, in syntax any Node still parses, so an old Node gets a clear message rather
// than a syntax error from the launcher.
var parts = process.versions.node.split(".").map(Number)
if (parts[0] < 22 || (parts[0] === 22 && parts[1] < 12)) {
  console.error(
    "\n✗ Box Yard needs Node.js 22.12 or newer; this is " +
      process.version +
      ".\n  → Install the LTS from https://nodejs.org (with nvm: nvm install 22 && nvm use 22), then run the command again.\n",
  )
  process.exit(1)
}
import("../launcher/main.mjs").then(
  function (m) {
    return m.main(process.argv.slice(2)).then(function (code) {
      process.exitCode = code
    })
  },
  function (err) {
    console.error(err)
    process.exit(1)
  },
)
