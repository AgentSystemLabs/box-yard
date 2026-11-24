// @vitest-environment happy-dom
// Voice on/off is one switch on the server, not one per browser: the owner turned voice off in one tab and another
// Box Yard window (another port, profile or phone, each with its own localStorage) kept talking.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TTS_DEFAULTS, type TtsInfo } from "../shared/tts.js"
import { VOICE_DEFAULTS, VOICE_KEY } from "../web/src/lib/voice.js"

const info = (patch: Partial<TtsInfo>): TtsInfo => ({
  settings: TTS_DEFAULTS,
  defaults: TTS_DEFAULTS,
  sources: { provider: "default", elevenlabs: "default", openai: "default" },
  keys: { elevenlabs: { state: "unset", source: "default" }, openai: { state: "unset", source: "default" } },
  ...patch,
})

/** A fresh page: speech.ts and tts.ts load anew, reading this browser's localStorage. */
async function openPage(stored: { enabled: boolean }) {
  localStorage.setItem(VOICE_KEY, JSON.stringify({ ...VOICE_DEFAULTS, ...stored }))
  vi.resetModules()
  const speech = await import("../web/src/lib/speech.js")
  const tts = await import("../web/src/lib/tts.js")
  return { ...speech, setTtsInfo: tts.setTtsInfo }
}

beforeEach(() => localStorage.clear())
afterEach(() => vi.unstubAllGlobals())

describe("voice on/off", () => {
  it("follows the server's switch, so off in another browser silences this one", async () => {
    const page = await openPage({ enabled: true })
    page.setTtsInfo(info({ announcements: true, announcementsSource: "ui" }))
    expect(page.getVoiceSettings().enabled).toBe(true)

    // Another browser turned voice off: the server's `tts` event reaches this page.
    page.setTtsInfo(info({ announcements: false, announcementsSource: "ui" }))
    expect(page.getVoiceSettings().enabled).toBe(false)
    // A reload before the server answers keeps it off too.
    expect(JSON.parse(localStorage.getItem(VOICE_KEY)!).enabled).toBe(false)
  })

  it("keeps a browser that had voice off quiet after the update, and turns it off on the server", async () => {
    const calls: unknown[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push(JSON.parse(String(init.body)))
        return new Response(JSON.stringify(info({ announcements: false, announcementsSource: "ui" })), { status: 200 })
      }),
    )
    const page = await openPage({ enabled: false })
    // The server's switch was never set (it used to be per browser), so it reports its default: on.
    page.setTtsInfo(info({ announcements: true, announcementsSource: "default" }))
    expect(page.getVoiceSettings().enabled).toBe(false)
    expect(calls).toEqual([{ announcements: false }])
  })
})
