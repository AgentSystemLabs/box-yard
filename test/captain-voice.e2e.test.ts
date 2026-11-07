import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import fs from "node:fs"
import path from "node:path"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { CaptainMessage, CaptainSource, Project, UiEvent } from "../shared/types.js"
import { freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

let yard: BoxYard | undefined
let server: Server | undefined

afterEach(async () => {
  if (yard) await waitFor(() => !yard!.captains.anyBusy() && !yard!.orchestrator.busy, "all chat turns to settle")
  yard?.stop()
  await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve())
  yard = undefined
  server = undefined
})

describe("Captain reply provenance", () => {
  it.each([
    { name: "commentary without a final answer", phase: "commentary", result: { type: "turn.completed" } },
    { name: "an incomplete Codex stream", phase: "final_answer", result: null },
    { name: "a failed Codex turn", phase: "final_answer", result: { type: "turn.failed", error: { message: "The connection dropped." } } },
  ])("never marks $name as a speakable reply", async ({ phase, result }) => {
    const script = path.join(tmpDir(), "voice-stream.mjs")
    const events = [
      { type: "thread.started", thread_id: "voice-thread" },
      { type: "item.completed", item: { id: "item_voice", type: "agent_message", text: "Checking the project.", phase } },
      ...(result ? [result] : []),
    ]
    fs.writeFileSync(script, `process.stdin.resume(); process.stdin.on("end", () => { for (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event)) })`)
    const port = await freePort()
    yard = createBoxYard(testConfig({ port, codexBin: `${process.execPath} ${script}` }), { webDir: "/nonexistent" })
    yard.settings.update({ captainCli: "codex" })
    const project = yard.store.createProject({ name: "Voice stream" })
    yard.captains.send(project.id, "Check the project", { source: "cody" })
    await waitFor(() => !yard!.captains.anyBusy(), "the stream to end")
    const replies = yard.store.listCaptainMessages(project.id).filter((message) => message.role === "assistant")
    expect(replies).toHaveLength(1)
    expect(replies[0]!.meta?.finalReply).not.toBe(true)
  })

  it.each(["claude", "codex"] as const)("persists the %s turn's source and marks only its completed final reply", async (cli) => {
    const port = await freePort()
    yard = createBoxYard(testConfig({ port }), { webDir: "/nonexistent" })
    yard.settings.update({ captainCli: cli })
    yard.captains.tuning.wakeDebounceMs = 20
    const events: UiEvent[] = []
    const broadcast = yard.hub.broadcast.bind(yard.hub)
    yard.hub.broadcast = (event) => {
      events.push(event)
      broadcast(event)
    }
    server = await new Promise<Server>((resolve) => {
      const listening = yard!.app.listen(port, "127.0.0.1", () => resolve(listening))
    })
    await yard.start()
    const base = `http://127.0.0.1:${port}`
    const response = await fetch(`${base}/api/projects`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Voice demo" }) })
    const project = await response.json() as Project
    expect(response.status).toBe(201)
    let turns = 0
    const finished = () => waitFor(() => {
      const timings = yard!.store.listTurnTimings({ since: 0, projectId: project.id, role: "captain", kind: "turn" })
      return timings.length >= turns && !yard!.captains.anyBusy()
    }, "the Captain turn to finish")

    for (const source of ["cody", "coordinator", "agent", "hook", "schedule", "updates"] as const) {
      const firstEvent = events.length
      if (source === "cody") {
        const sent = await fetch(`${base}/api/projects/${project.id}/captain/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "status" }) })
        expect(sent.status).toBe(201)
      } else if (source === "updates") {
        yard.captains.projectNotice(project.id, "A task finished; check the project.")
      } else {
        yard.captains.send(project.id, "status", { source: source as CaptainSource })
      }
      turns++
      await finished()
      const messages = events.slice(firstEvent).flatMap((event) => event.type === "captain.message" && event.message.role === "assistant" ? [event.message] : [])
      const final = messages.filter((message) => message.meta?.finalReply === true)
      expect(final).toHaveLength(1)
      expect(final[0]!.meta).toMatchObject({ turnSource: source, finalReply: true })
      expect(messages.filter((message) => !message.meta?.finalReply).every((message) => message.meta?.turnSource === source)).toBe(true)
      const saved = yard.store.listCaptainMessages(project.id).find((message) => message.id === final[0]!.id)
      expect(saved?.meta).toMatchObject({ turnSource: source, finalReply: true })
    }

    yard.captains.send(project.id, "status [slow:1]", { source: "cody" })
    await waitFor(() => yard!.captains.anyBusy(), "the first turn to start")
    yard.captains.send(project.id, "status", { source: "coordinator" })
    yard.captains.send(project.id, "status", { source: "cody" })
    turns += 2
    await finished()
    const last = yard.store.listCaptainMessages(project.id).filter((message) => message.meta?.finalReply === true).at(-1)!
    expect(last.meta?.turnSource).toBe("coordinator")
  })
})
