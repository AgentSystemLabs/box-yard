import { describe, expect, it } from "vitest"
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { SettingsStore } from "../server/settings.js"
import { captainPrompt, firstTurnPrompt, followupPrompt, ORCHESTRATOR_PROMPT, workerSystemPrompt } from "../server/prompts.js"
import { routingInstructions } from "../server/routing.js"
import { buildMcpServer, type McpDeps } from "../server/mcp.js"
import { DEFAULT_OWNER_NAME, withOwner } from "../shared/owner.js"
import { initiatorLabel } from "../shared/boxSizes.js"
import { boxActorLabel } from "../shared/boxHistory.js"
import { sourceLabel } from "../shared/hooks.js"
import { previewLine } from "../shared/tts.js"
import { buildSelectionTaskPrompt } from "../web/src/lib/selectionTask.js"
import { projectNote, inlinePicksNote } from "../server/runTargets.js"
import { routeRules, taskThreadPrompt } from "../server/sideThreads.js"
import { userMessageLabel } from "../shared/sender.js"
import type { Project } from "../shared/types.js"
import { tmpDir } from "./helpers.js"

const memStore = () => new Store(openDb(tmpDir(), ":memory:"))
const noEnv = { orchestratorModel: "", workerModel: "", captainModel: "", captainEffort: "" as const }

const project = {
  id: "prj_1",
  name: "Cody's site",
  description: "Built for Cody",
  repo: "acme/site",
  baseBranch: "main",
} as Project

describe("withOwner", () => {
  it("uses a neutral fallback for an unset or blank name", () => {
    expect(withOwner("Ask Cody.", undefined)).toBe("Ask the owner.")
    expect(withOwner("Ask Cody.", " ")).toBe("Ask the owner.")
    expect(withOwner("Ask Cody.", DEFAULT_OWNER_NAME)).toBe("Ask the owner.")
  })

  it("swaps whole-word mentions, possessives included", () => {
    expect(withOwner("Ask Cody; Cody's UI. Codyish stays.", "Ana")).toBe("Ask Ana; Ana's UI. Codyish stays.")
    // Replacement patterns like $& are inserted literally.
    expect(withOwner("Ask Cody.", "$&")).toBe("Ask $&.")
  })
})

describe("ownerName setting", () => {
  it("defaults to the owner, takes BOXYARD_OWNER_NAME, and the UI value wins", () => {
    expect(new SettingsStore(memStore(), noEnv).info().settings.ownerName).toBe("the owner")
    const settings = new SettingsStore(memStore(), { ...noEnv, ownerName: "Ana" })
    expect(settings.info().settings.ownerName).toBe("Ana")
    expect(settings.info().sources.ownerName).toBe("env")
    const info = settings.update({ ownerName: "  Sam  " })
    expect(info.settings.ownerName).toBe("Sam")
    expect(info.sources.ownerName).toBe("ui")
  })

  it("preserves explicitly configured names, including the former default, without rewriting settings", () => {
    const store = memStore()
    const settings = new SettingsStore(store, { ...noEnv, ownerName: " " })
    expect(settings.get().ownerName).toBe("the owner")
    settings.update({ ownerName: "Cody" })
    const before = store.getKv("settings")
    expect(new SettingsStore(store, noEnv).get().ownerName).toBe("Cody")
    expect(store.getKv("settings")).toBe(before)
    expect(withOwner("Ask Cody.", "Cody")).toBe("Ask Cody.")
  })

  it("rejects empty or markup-like names", () => {
    const settings = new SettingsStore(memStore(), noEnv)
    expect(() => settings.update({ ownerName: "" })).toThrow()
    expect(() => settings.update({ ownerName: "<b>x</b>" })).toThrow()
    expect(() => settings.update({ ownerName: "x".repeat(41) })).toThrow()
  })
})

describe("prompts with an owner name", () => {
  it("worker system prompt uses the name but keeps the task title and project text as written", () => {
    const prompt = workerSystemPrompt({ project, task: { id: "task_1", title: "Fix Cody's bug" }, branch: "b", port: 4000, ownerName: "Ana" })
    expect(prompt).toContain("ask_user: ask Ana (the human)")
    expect(prompt).toContain("hidden next-step block for Ana's UI")
    expect(prompt).toContain(`"Fix Cody's bug"`)
    expect(prompt).toContain("Project description: Built for Cody")
    expect(prompt.replace(/Fix Cody's bug|Cody's site|Built for Cody/g, "")).not.toMatch(/\bCody\b/)
  })

  it("uses the owner when no name was configured", () => {
    const base = { project, task: { id: "task_1", title: "T" }, branch: "b", port: 4000 }
    expect(workerSystemPrompt({ ...base, ownerName: "the owner" })).toBe(workerSystemPrompt(base))
  })

  it("labels follow-ups and notes with the name, not message content", () => {
    const text = followupPrompt(
      [
        { source: "cody", content: "Cody here" },
        { source: "orchestrator", content: "x" },
        { source: "captain:prj_1", content: "y" },
      ],
      () => "site",
      "Ana",
    )
    expect(text).toContain("Message from Ana:\n\nCody here")
    expect(text).toContain("Coordinator (on Ana's behalf)")
    expect(text).toContain("Message from the site Captain (on Ana's behalf)")
    const first = firstTurnPrompt({
      task: { title: "T", prompt: "p" },
      notes: [{ author: "Cody", content: "Cody likes tabs" }],
      hiddenNotes: 2,
      directory: [],
      extraInputs: [],
      ownerName: "Ana",
    })
    expect(first).toContain("lasting rules from Ana and the project's Captain")
    expect(first).toContain("(Cody) Cody likes tabs")
    expect(first).toContain("2 older notes don't fit the notes budget")
  })

  it("Coordinator, Captain and routing prompts have no Cody left", () => {
    expect(withOwner(ORCHESTRATOR_PROMPT, "Ana")).not.toMatch(/\bCody\b/)
    expect(captainPrompt(project, "Ana").replace(/Cody's site|Built for Cody/g, "")).not.toMatch(/\bCody\b/)
    expect(routingInstructions(tmpDir(), { agentRoutingConfig: "", ownerName: "Ana" })).not.toMatch(/\bCody\b/)
  })

  it("transcript labels use the name", () => {
    expect(userMessageLabel({}, "Ana")).toBe("Ana")
    expect(userMessageLabel({})).toBe("the owner")
  })
})

describe("generated output boundaries", () => {
  it.each(["Ana", undefined, " "])("personalizes all runner and manager instructions (%s)", (ownerName) => {
    const clean = { ...project, name: "demo", description: "", repo: "acme/site" }
    const boxes = [undefined, { memoryBytes: null, slots: 1, local: true }, { memoryBytes: null, slots: 1, docker: { cpus: 2 } }, { memoryBytes: null, slots: 1, machine: { name: "Example", os: null, cpus: 2 } }, { memoryBytes: null, slots: 1, gpu: { name: "GPU", cloud: "daytona" as const } }]
    for (const box of boxes) {
      const prompt = workerSystemPrompt({ project: clean, task: { id: "task_1", title: "T" }, branch: "main", port: 4000, box, ownerName })
      expect(prompt).not.toMatch(/cody/i)
      expect(prompt).toContain(`ask ${ownerName?.trim() || "the owner"} (the human)`)
    }
    expect(captainPrompt(clean, ownerName, undefined, true, "/example/repo")).not.toMatch(/cody/i)
    expect(withOwner(ORCHESTRATOR_PROMPT, ownerName)).not.toMatch(/cody/i)
    expect(sourceLabel("cody", ownerName)).toBe(ownerName?.trim() || "the owner")
    expect(initiatorLabel({ kind: "cody" }, undefined, ownerName)).toBe(ownerName?.trim() || "the owner")
    expect(boxActorLabel({ actor: "owner", actorProjectId: null }, undefined, ownerName)).toBe(ownerName?.trim() || "the owner")
    expect(userMessageLabel({}, ownerName)).toBe(ownerName?.trim() || "the owner")
    expect(previewLine("Example", ownerName)).toBe(ownerName?.trim() ? "Hi Ana, this is Example." : "Hi, this is Example.")
  })

  it("keeps repositories, branches, parent and machine names, paths and quoted instructions unchanged", () => {
    const p = { ...project, repo: "Cody/site", baseBranch: "Cody" }
    const prompt = workerSystemPrompt({ project: p, task: { id: "task_1", title: "Cody" }, branch: "Cody", port: 4000, ownerName: "Ana", box: { memoryBytes: null, slots: 1, machine: { name: "Cody", os: "Cody OS", cpus: 1 } }, subtasks: { depth: 1, maxDepth: 3, maxChildren: 2, parent: { id: "task_parent", title: "Cody" } } })
    for (const text of ['on Cody, one of Ana', 'Cody OS', 'repository Cody/site', 'on branch Cody', 'push to Cody directly', 'sub-task of "Cody"']) expect(prompt).toContain(text)
    const captain = captainPrompt(p, "Ana", undefined, false, "/Cody/repo")
    expect(captain).toContain("Repository: Cody/site (base branch Cody)")
    expect(captain).toContain("at /Cody/repo")
    expect(routeRules({ task: { id: "task_1", title: "Cody" }, ownerName: "Ana" })).toContain('task "Cody"')
    expect(taskThreadPrompt({ title: "Cody", state: "idle", notices: "Cody", question: "Cody?", context: null, ownerName: "Ana" })).toContain('task "Cody"')
    expect(routingInstructions(tmpDir(), { agentRoutingConfig: "", agentCodexModel: "Cody", ownerName: "Ana" })).toContain("Codex model Cody")
    expect(projectNote({ token: "Cody", label: "Cody", value: "prj_1" }, "Ana")).toContain('project "Cody"')
    expect(inlinePicksNote([{ kind: "project", token: "Cody", label: "Cody", value: "prj_1", where: 'item 1 ("Cody")', reason: "item" }], "Ana", false)).toContain('item 1 ("Cody")')
    const selection = buildSelectionTaskPrompt({ source: { kind: "orchestrator" }, selectedText: "Cody said hello", instructions: "Ask Cody", ownerName: "Ana" })
    expect(selection).toContain("## Ana's additional instructions\nAsk Cody")
    expect(selection).toContain("> Cody said hello")
  })
})

describe("box runner MCP tools", () => {
  it.each(["Ana", undefined, " "])("names the owner from task.json (%s) in tool descriptions", async (ownerName) => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify({ taskId: "task_1", ownerName, env: {} }))
    const runner = path.resolve(import.meta.dirname, "../runner/box-runner.mjs")
    const child = spawn(process.execPath, [runner, "mcp", dir], { stdio: ["pipe", "pipe", "inherit"] })
    const reply = new Promise<string>((resolve) => {
      let out = ""
      child.stdout.on("data", (d) => {
        out += d
        if (out.includes("\n")) resolve(out)
      })
    })
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n")
    const text = await reply
    child.kill()
    const tools = JSON.parse(text.split("\n")[0]!).result.tools as { name: string; description: string }[]
    expect(tools.find((t) => t.name === "ask_user")!.description).toContain(`Ask ${ownerName?.trim() || "the owner"} (the human)`)
    expect(JSON.stringify(tools)).not.toMatch(/\bCody\b/)
  })
})

describe("Box Yard MCP tools", () => {
  it("interpolates names containing the template name exactly once", () => {
    const deps = { settings: { get: () => ({ ownerName: "Cody Lee" }) } } as unknown as McpDeps
    const tools = (buildMcpServer(deps) as unknown as { _registeredTools: Record<string, { description?: string }> })._registeredTools
    expect(tools.list_projects!.description).toContain("in the order Cody Lee keeps")
    expect(tools.send_to_captain!.description).toContain("on Cody Lee's chat")
    expect(JSON.stringify(Object.values(tools).map((t) => t.description))).not.toContain("Cody Lee Lee")
  })

  it.each(["Ana", undefined, " "])("names the owner (%s) in tool and parameter descriptions", (ownerName) => {
    const deps = { settings: { get: () => ({ ownerName }) } } as unknown as McpDeps
    // Registered tools aren't public API; read them to check the descriptions without a transport.
    const tools = Object.values((buildMcpServer(deps) as unknown as { _registeredTools: Record<string, { description?: string; inputSchema?: { shape?: Record<string, { description?: string }> } }> })._registeredTools)
    const text = JSON.stringify(tools.map((t) => [t.description, Object.values(t.inputSchema?.shape ?? {}).map((v) => v.description)]))
    expect(text).toContain(`when ${ownerName?.trim() || "the owner"} explicitly asks`)
    expect(text).toContain(`paths ${ownerName?.trim() || "the owner"} attached`)
    expect(text).not.toMatch(/\bCody\b/)
  })
})
