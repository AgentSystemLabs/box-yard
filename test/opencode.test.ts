import { afterEach, describe, expect, it } from "vitest"
import { AGENT_CLIS, AGENT_CLI_LABEL, canSteer, cliForModel, codexModel, hasSeparateEffort, isManagerCli, isOpenCodeModel } from "../shared/agentCli.js"
import { harnessDefaults } from "../shared/harnessDefaults.js"
import { harnessModelTargets, modelToken } from "../shared/harnessPicks.js"
import { buildHarnessTargets } from "../shared/runTargets.js"
import { SettingsStore, settingsPatch } from "../server/settings.js"
import { CredentialStore } from "../server/credentials.js"
import { parseOpenCodeAuth, openCodeArgs } from "../server/opencode.js"
import { credentialSet, openCodeTurnLogin } from "../server/turnCredentials.js"
import { Setup } from "../server/setup.js"
import { Store } from "../server/store.js"
import { openDb } from "../server/db.js"
import { testConfig } from "./helpers.js"
import { settingsProblems } from "../web/src/lib/settingsValidation.js"
import { parseProbe, testFromProbe } from "../server/machines/probe.js"
import { agentEnv } from "../server/providers/local.js"
import { TaskManager } from "../server/tasks.js"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { tmpDir } from "./helpers.js"

const auth = JSON.stringify({ example: { type: "api", key: "example-api-fixture" } })
const stores: Store[] = []
afterEach(() => { for (const s of stores.splice(0)) s.db.close() })

function fixture(localTool = { found: true, version: "1.19.5" }) {
  const c = testConfig({ mock: false, provider: "upstash", upstashBoxApiKey: "example-upstash", runpodApiKey: "example-runpod", vastApiKey: "example-vast", daytonaApiKey: "example-daytona" })
  const store = new Store(openDb(c.dataDir)); stores.push(store)
  const settings = new SettingsStore(store, c)
  const credentials = new CredentialStore(store, c)
  const setup = new Setup({ c, store, settings, credentials, provider: () => "upstash", dockerProblem: async () => null, machinesProblem: () => null, localCheck: async () => ({ check: { tools: [{ key: "opencode", ...localTool }], opencodeLogin: false, claudeLogin: false, ghLogin: false, checkedAt: Date.now() }, ghToken: "" }) })
  return { c, store, settings, credentials, setup }
}

describe("OpenCode's verified task contract", () => {
  it("is present across registry defaults, picks, saved settings and capabilities, without changing manager allowlists", () => {
    const defaults = harnessDefaults({ agentOpencodeModel: "example/model#high" })
    const roots = buildHarnessTargets({ problems: Object.fromEntries(AGENT_CLIS.map((cli) => [cli, null])) as Record<(typeof AGENT_CLIS)[number], null> })
    for (const cli of AGENT_CLIS) {
      expect(AGENT_CLI_LABEL[cli]).toBeTruthy()
      expect(defaults[cli]).toBeDefined()
      expect(roots.some((r) => r.value === cli)).toBe(true)
    }
    expect(isManagerCli("opencode")).toBe(false)
    expect(canSteer("opencode")).toBe(false)
    expect(hasSeparateEffort("opencode")).toBe(false)
    const picks = harnessModelTargets(roots, { defaults, cursor: [] }).filter((t) => t.value === "opencode")
    expect(picks.map((t) => t.token)).toEqual(["opencode", `opencode:${modelToken("example/model#high")}`])
    expect(picks.every((p) => !p.effort)).toBe(true)
    const { settings } = fixture()
    settings.update({ agentCli: "opencode", agentOpencodeModel: "example/model#high" })
    expect(settings.get()).toMatchObject({ agentCli: "opencode", agentOpencodeModel: "example/model#high" })
    for (const id of ["", "example/model", "example/model#high"]) {
      expect(settingsPatch.safeParse({ agentOpencodeModel: id }).success).toBe(true)
      expect(settingsProblems({ agentOpencodeModel: id })).toEqual({})
    }
    expect(settingsPatch.safeParse({ agentOpencodeModel: "opus" }).success).toBe(false)
    expect(settingsProblems({ agentOpencodeModel: "opus" })).toHaveProperty("agentOpencodeModel")
  })

  it("keeps provider/model and explicit variants out of other harness routing and constructs only documented arguments", () => {
    expect(cliForModel("example/model#high")).toBe("opencode")
    expect(cliForModel("opus")).toBe("claude")
    expect(cliForModel("gpt-6.1-sol")).toBe("codex")
    expect(codexModel("example/model", "gpt-6.1-sol")).toBe("gpt-6.1-sol")
    expect(openCodeArgs("example/model#high", "ses_example")).toEqual(["run", "--format", "json", "--auto", "--pure", "--model", "example/model", "--variant", "high", "--session", "ses_example"])
    expect(openCodeArgs(null, null)).toEqual(["run", "--format", "json", "--auto", "--pure"])
    for (const id of ["opus", "--bad", "example/", "example/model#", "example/model#x#y", "example/model with spaces"]) expect(isOpenCodeModel(id), id).toBe(false)
  })

  it("validates API login JSON, scopes credentials and redacts individual provider keys", async () => {
    for (const bad of ["oops", "{}", "[]", '{"example":{"type":"oauth","access":"secret"}}']) expect(() => parseOpenCodeAuth(bad)).toThrow(/OpenCode/)
    expect(openCodeTurnLogin({}, auth)).toEqual({ from: "global", env: { OPENCODE_AUTH_CONTENT: auth } })
    expect(openCodeTurnLogin({ OPENAI_API_KEY: "example-own-key" }, auth)).toEqual({ from: "project", env: { OPENAI_API_KEY: "example-own-key" } })
    expect(credentialSet("prj_example", { OPENCODE_AUTH_CONTENT: auth })).toBe("project:prj_example")
    const { credentials, setup } = fixture()
    credentials.update({ opencodeAuthJson: auth })
    expect(credentials.secrets()).toContain("example-api-fixture")
    expect(JSON.stringify(credentials.status())).not.toContain("example-api-fixture")
    expect(await setup.test("opencodeAuthJson", auth)).toMatchObject({ ok: true, message: expect.stringContaining("not sent to a provider") })
  })

  it("requires scoped API logins before creating isolated runners and reports an unavailable local CLI", async () => {
    const { c, setup } = fixture()
    for (const [runner, cloud] of [["box", undefined], ["docker", undefined], ["gpu", "runpod"], ["gpu", "vast"], ["gpu", "daytona"]] as const) {
      expect(await setup.runnerProblem(runner, false, "opencode", cloud)).toMatch(/OpenCode needs provider API credentials/)
      expect(await setup.runnerProblem(runner, true, "opencode", cloud)).toBeNull()
    }
    expect(await setup.runnerProblem("local", false, "opencode")).toMatch(/API credentials/)
    expect(await setup.runnerProblem("local", true, "opencode")).toBeNull()
    expect(await fixture({ found: false, version: "" }).setup.runnerProblem("local", true, "opencode")).toMatch(/isn't installed/)
    expect(await fixture({ found: true, version: "2.0.0" }).setup.runnerProblem("local", true, "opencode")).toMatch(/1.19.5 is required/)
    expect(await setup.runnerProblem("ssh", false, "opencode")).toBeNull() // individual placement verifies the machine
    c.boxProvider = "local"
    expect(await setup.runnerProblem("box", false, "opencode")).toBeNull()
  })

  it("recognizes an OpenCode-only SSH machine and keeps server-only auth and config out of the inherited environment", () => {
    const probe = testFromProbe({ first: parseProbe("BOXYARD_PROBE\nworkdir=/example/tasks\n"), tools: parseProbe("BOXYARD_PROBE\npath_git=/usr/bin/git\npath_node=/usr/bin/node\nversion_node=v24.0.0\npath_opencode=/usr/bin/opencode\nversion_opencode=1.19.5\nopencode_auth=yes\n"), pathDirs: [], latencyMs: 1, at: 1 })
    expect(probe.problems).toEqual([])
    expect(probe.tools.opencode).toMatchObject({ found: true, version: "1.19.5" })
    expect(probe.opencodeLogin).toBe(true)
    expect(agentEnv({ PATH: "/usr/bin", OPENCODE_AUTH_CONTENT: auth, OPENCODE_API_KEY: "example", OPENCODE_CONFIG_CONTENT: "{}", OPENCODE_CONFIG: "/example/config", GOOGLE_GENERATIVE_AI_API_KEY: "example" })).toEqual({ PATH: "/usr/bin" })
  })

  it("installs only in managed sandbox homes and makes install failures actionable, without touching owner runners", async () => {
    const home = tmpDir("opencode-sandbox-home")
    const bin = path.join(home, "bin")
    fs.mkdirSync(bin)
    // This fake npm checks the requested package/prefix and writes a harmless executable; it cannot reach a registry.
    fs.writeFileSync(path.join(bin, "npm"), '#!/bin/sh\n[ "$1" = install ] && [ "$2" = --prefix ] && [ "$4" = opencode-ai@1.19.5 ] || exit 2\nmkdir -p "$3/node_modules/.bin"\nprintf "#!/bin/sh\\necho 1.19.5\\n" > "$3/node_modules/.bin/opencode"\nchmod +x "$3/node_modules/.bin/opencode"\n', { mode: 0o755 })
    const calls: string[] = []
    const provider = { name: "docker", exec: async (_id: string, cmd: string) => {
      calls.push(cmd)
      try { return { exitCode: 0, stdout: execFileSync("/bin/sh", ["-c", cmd], { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf8" }), stderr: "" } }
      catch { return { exitCode: 1, stdout: "", stderr: "" } }
    } }
    const context = { provider, c: { mock: false }, openCodeReady: new Set<string>() }
    const install = TaskManager.prototype["ensureOpenCode"].bind(context)
    await install("example-sandbox")
    expect(fs.existsSync(path.join(home, ".boxyard-tools/opencode/node_modules/.bin/opencode"))).toBe(true)
    await install("example-sandbox")
    expect(calls).toHaveLength(1)
    for (const owner of ["local", "ssh"]) {
      provider.name = owner
      await install(`example-${owner}`)
    }
    expect(calls).toHaveLength(1)
    provider.name = "upstash"
    provider.exec = async () => ({ exitCode: 1, stdout: "", stderr: "example fixture failure" })
    await expect(install("example-failure")).rejects.toThrow(/registry access and available disk space/)
  })

  it("records identical per-run costs on resumed sessions without subtracting earlier runs", () => {
    const { store } = fixture()
    for (let i = 0; i < 2; i++) store.recordClaudeUsage({ source: "task", runKind: "turn", sessionId: "ses_example", startedAt: i, endedAt: i + 1, durationMs: 1, resumed: i > 0, costScope: "run", costUsd: 0.2, usage: { input_tokens: 200, output_tokens: 50 } })
    expect(store.db.prepare("SELECT cost_usd, total_tokens FROM claude_usage ORDER BY ended_at").all()).toEqual([{ cost_usd: 0.2, total_tokens: 250 }, { cost_usd: 0.2, total_tokens: 250 }])
  })
})
