import { config, configProblems } from "./config.js"
import { createBoxYard } from "./app.js"
import { hasOwnCodexLogin } from "./chatAgent.js"
import { bindProblem, isLoopback, listenUrls } from "./bind.js"
import { lockDataDir } from "./dataLock.js"
import { passwordProblems, passwordRefusal } from "./password.js"
import { RUNNER_PHRASE } from "../shared/runner.js"

const weak = config.password ? passwordProblems(config.password) : []
const refused = weak.length ? passwordRefusal(weak) : bindProblem(config)
if (refused) {
  console.error(`\n[box-yard] Not starting.\n${refused.replace(/^/gm, "  ")}\n`)
  process.exit(1)
}

// One Box Yard per data folder: a second one would run every task twice. On a restart, waits for the old one to go.
const lock = await lockDataDir(config.dataDir, { host: config.host, port: config.port }).catch((err: unknown) => {
  console.error(`\n[box-yard] Not starting. ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
process.on("exit", () => lock.release())

const yard = createBoxYard(config)

const server = yard.app.listen(config.port, config.host, async () => {
  const runner = yard.setup.runnerChoice()
  // Agents on this computer: look at its claude first, so a missing or signed-out one is named here, not in a failed task.
  const local = runner === "local" ? await yard.setup.refreshLocal().then(() => yard.setup.runnerProblem("local")) : null
  console.log(`\n  Box Yard is running on:`)
  for (const u of listenUrls(config.host, config.port)) console.log(`    ${`${u.label}:`.padEnd(11)} ${u.url}`)
  if (isLoopback(config.host)) console.log(`  (this computer only: set BOXYARD_PASSWORD to open it to your network and Tailscale)`)
  else if (!config.password) console.log(`  ! No BOXYARD_PASSWORD (BOXYARD_ALLOW_OPEN=1): anyone who can reach these addresses can use Box Yard.`)
  console.log(`  agents run on: ${runner ? RUNNER_PHRASE[runner] : "not chosen yet"} (Settings › Credentials) · data: ${config.dataDir}`)
  if (runner !== "local") console.log(`  boxes: ${config.provider} (default max ${config.maxBoxes} boxes × ${config.slotsPerBox} tasks at once)`)
  if (local) console.log(`  ! ${local}. Tasks on this computer can't start until then; open Box Yard to finish setup or pick another runner.`)
  const claudeLogin = yard.setup.localCheck()?.claudeLogin === true
  // The credentials in effect (saved, env, or this computer's gh login), as /api/health reads them.
  for (const p of configProblems({ ...config, ...yard.settings.credentials.values() }, { coordinatorCli: yard.settings.get().orchestratorCli, codexLogin: hasOwnCodexLogin(), claudeLogin })) {
    // The line above already says what this computer's claude needs.
    if (!(local && /^Claude isn't signed in/.test(p))) console.log(`  ! ${p}`)
  }
  console.log("")
})
server.on("error", (err) => {
  console.error(`[box-yard] can't listen on ${config.host}:${config.port}: ${err.message}`)
  process.exit(1)
})

await yard.start()

let shuttingDown = false
const shutdown = (signal: string) => {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[box-yard] ${signal}: shutting down. Running agents keep working, in their boxes and on this computer, and are picked up on restart.`)
  server.close()
  yard.stop()
  setTimeout(() => process.exit(0), 500).unref()
}
process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("unhandledRejection", (err) => console.error("[box-yard] unhandled rejection", err))
