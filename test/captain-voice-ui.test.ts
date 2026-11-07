// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { CaptainMessage, UiEvent } from "../shared/types.js"
import { TTS_DEFAULTS } from "../shared/tts.js"
import { useServerEvents } from "../web/src/lib/stream.js"
import { keys } from "../web/src/lib/queries.js"
import { setVoiceSettings, stopSpeech, type UtteranceLike } from "../web/src/lib/speech.js"
import { setTtsInfo } from "../web/src/lib/tts.js"
import { VOICE_DEFAULTS } from "../web/src/lib/voice.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class FakeEventSource {
  static connections: FakeEventSource[] = []
  onmessage: ((event: { data: string }) => void) | null = null
  onopen = null
  onerror = null
  addEventListener() {}
  constructor() {
    FakeEventSource.connections.push(this)
  }
  close() {}
}

let root: Root
let host: HTMLElement
let client: QueryClient
let spoken: string[]
let sequence = 0
let clock = Date.now()

function Connection() {
  useServerEvents(true)
  return null
}

function message(source: string | null = "cody", extra: Partial<CaptainMessage> = {}): CaptainMessage {
  return {
    id: `cap_voice${++sequence}`,
    projectId: "prj_voice001",
    role: "assistant",
    content: "The pricing update is ready for your review.",
    createdAt: Date.now(),
    meta: { turnSource: source, finalReply: true },
    ...extra,
  }
}

async function emit(...events: UiEvent[]) {
  await act(async () => {
    for (const connection of FakeEventSource.connections) {
      for (const event of events) connection.onmessage?.({ data: JSON.stringify(event) })
    }
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
}

beforeEach(() => {
  clock += 20_000
  vi.spyOn(Date, "now").mockReturnValue(clock)
  localStorage.clear()
  FakeEventSource.connections = []
  spoken = []
  vi.stubGlobal("EventSource", FakeEventSource)
  vi.stubGlobal("SpeechSynthesisUtterance", class {
    constructor(readonly text: string) {}
  })
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: {
      speak(utterance: UtteranceLike) {
        if (utterance.text) spoken.push(utterance.text)
        queueMicrotask(() => utterance.onend?.({}))
      },
      cancel() {},
      pause() {},
      resume() {},
      speaking: false,
      paused: false,
      getVoices: () => [],
    },
  })
  setTtsInfo({ settings: TTS_DEFAULTS, defaults: TTS_DEFAULTS, sources: { provider: "default", elevenlabs: "default", openai: "default" }, keys: { elevenlabs: { state: "unset", source: "default" }, openai: { state: "unset", source: "default" } } })
  setVoiceSettings(VOICE_DEFAULTS)
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(keys.captainMessages("prj_voice001"), [])
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(createElement(QueryClientProvider, { client }, createElement(Connection))))
})

afterEach(() => {
  act(() => root.unmount())
  stopSpeech()
  client.clear()
  host.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("Captain voice from the shared server stream", () => {
  it("speaks a direct prompt's final reply with the default settings", async () => {
    await emit({ type: "captain.message", message: message() })
    expect(spoken).toEqual(["The pricing update is ready for your review."])
  })

  it("leaves a Coordinator-to-Captain turn silent and lets the Coordinator relay it", async () => {
    const reply = message("coordinator")
    await emit({ type: "captain.message", message: reply })
    expect(spoken).toEqual([])
    await emit(
      { type: "chat.message", message: { ...reply, id: "chat_voice001" } },
      { type: "chat.turn", startedAt: Date.now(), replyId: "chat_voice001" },
    )
    expect(spoken).toEqual([reply.content])
  })

  it.each(["updates", "agent", "hook", "schedule", null])("leaves a %s turn silent", async (source) => {
    await emit({ type: "captain.message", message: message(source) })
    expect(spoken).toEqual([])
  })

  it("stays silent when Read Captain replies aloud is off, including a later replay", async () => {
    setVoiceSettings({ captains: false })
    const reply = message()
    await emit({ type: "captain.message", message: reply })
    expect(spoken).toEqual([])
    setVoiceSettings({ captains: true })
    await emit({ type: "captain.message", message: reply })
    expect(spoken).toEqual([])
  })

  it("respects mute, quiet hours and background-only", async () => {
    setVoiceSettings({ enabled: false })
    await emit({ type: "captain.message", message: message() })
    const hour = new Date().getHours()
    const time = (value: number) => `${String(value % 24).padStart(2, "0")}:00`
    setVoiceSettings({ enabled: true, quietHours: { enabled: true, start: time(hour), end: time(hour + 1) } })
    await emit({ type: "captain.message", message: message() })
    setVoiceSettings({ quietHours: VOICE_DEFAULTS.quietHours, backgroundOnly: true })
    await emit({ type: "captain.message", message: message() })
    expect(spoken).toEqual([])
  })

  it("skips progress and tools, then reads only the completed final reply", async () => {
    const reply = message()
    await emit(
      { type: "captain.message", message: message("cody", { content: "I am checking the project.", meta: { turnSource: "cody" } }) },
      { type: "captain.message", message: message("cody", { role: "tool", content: "list_tasks" }) },
      { type: "captain.message", message: { ...reply, meta: { turnSource: "cody" } } },
    )
    expect(spoken).toEqual([])
    await emit({ type: "captain.message", message: reply })
    expect(spoken).toEqual([reply.content])
  })

  it("doesn't repeat across surfaces, refetches, or SSE replays after the claim expires", async () => {
    act(() => root.render(createElement(QueryClientProvider, { client }, createElement("div", null, createElement(Connection), createElement(Connection)))))
    const reply = message()
    await emit({ type: "captain.message", message: reply })
    client.setQueryData(keys.captainMessages(reply.projectId), [reply])
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000)
    await emit({ type: "captain.message", message: reply })
    expect(spoken).toEqual([reply.content])
  })

  it("uses the existing cleanup for titles, URLs, SHAs, code and hidden next steps", async () => {
    await emit({ type: "captain.message", message: message("cody", {
      content: 'Finished [Pricing update](/tasks/task_abcdef12) at https://example.com with commit abcdef1234567890 and `npm test`.\n\n```sh\nsecret command\n```\n<!-- boxyard-next-steps\n["Run another check"]\n-->',
    }) })
    expect(spoken.join(" ")).toContain("Pricing update")
    expect(spoken.join(" ")).not.toMatch(/task_|https:|example\.com|abcdef|npm|secret|Run another check/)
  })
})
