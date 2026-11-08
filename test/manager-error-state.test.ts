import { afterEach, describe, expect, it, vi } from "vitest"
import { openDb } from "../server/db.js"
import { Hub } from "../server/hub.js"
import { Orchestrator } from "../server/orchestrator.js"
import { CaptainManager } from "../server/captains.js"
import { SettingsStore } from "../server/settings.js"
import { Store } from "../server/store.js"
import { testConfig } from "./helpers.js"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  vi.restoreAllMocks()
})

type Result = { ok: boolean; error: string; text: string; raw: string; sessionId: string | null; stopped?: boolean }
const success: Result = { ok: true, error: "", text: "Ready.", raw: "", sessionId: null }

describe.each(["coordinator", "captain"] as const)("%s status source", (kind) => {
  it("publishes a failed turn's error, clears it when retrying, and keeps success and Stop free of failure state", async () => {
    const config = testConfig({ orchestratorAutoWake: false })
    const db = openDb(config.dataDir)
    const store = new Store(db)
    const hub = new Hub()
    const settings = new SettingsStore(store, config)
    const mcp = { url: "http://example.invalid/mcp", token: "test" }
    const coordinator = new Orchestrator(config, store, hub, mcp, settings)
    const captains = new CaptainManager(config, store, hub, mcp, settings)
    const project = store.createProject({ name: "Demo" })
    const runner = kind === "coordinator" ? coordinator : captains.get(project.id)
    cleanups.push(() => db.close(), () => { coordinator.stop(); captains.stop(); hub.close() })
    const states: { busy: boolean; error: string | null }[] = []
    const broadcast = hub.broadcast.bind(hub)
    vi.spyOn(hub, "broadcast").mockImplementation((event) => {
      if ((kind === "coordinator" && event.type === "orchestrator.state") || (kind === "captain" && event.type === "captain.state")) states.push(event.state)
      broadcast(event)
    })
    // Keep the real send/drain/runPrompt/state plumbing; replace only the model process.
    const run = vi.spyOn(runner as unknown as { run(...args: unknown[]): Promise<Result> }, "run")
      .mockResolvedValue({ ...success, ok: false, error: "Model run failed" })
    const send = (text: string) => kind === "coordinator" ? coordinator.send(text) : captains.send(project.id, text, { source: "cody" })
    const idle = () => vi.waitFor(() => expect(runner.state().busy).toBe(false))

    send("Build the preview")
    await idle()
    expect(run).toHaveBeenCalledOnce()
    expect(runner.state().error).toBe("Model run failed")
    expect(states.at(-1)).toMatchObject({ busy: false, error: "Model run failed" })

    let complete!: (result: Result) => void
    run.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    send("Try again")
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    expect(runner.state()).toMatchObject({ busy: true, error: null })
    expect(states.at(-1)).toMatchObject({ busy: true, error: null })
    complete(success)
    await idle()
    expect(runner.state().error).toBeNull()

    run.mockResolvedValueOnce({ ...success, ok: false, stopped: true, error: "Stopped" })
    send("Stop this run")
    await idle()
    expect(run).toHaveBeenCalledTimes(3)
    expect(runner.state().error).toBeNull()
    expect(states.at(-1)).toMatchObject({ busy: false, error: null })
  })
})
