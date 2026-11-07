// @vitest-environment happy-dom
// The shortcuts list (lib/shortcuts.ts): its keys on a Mac and elsewhere, the "?" and ⌥⇧C hotkey tests, and where
// the composer jump lands from each part of the page.
import { afterEach, describe, expect, it } from "vitest"
import { chordLabel, chordText, composerJumpTarget, dictationChord, isComposerJumpKey, isShortcutsKey, paletteChord, shortcutGroups, spokenChord, voiceChord } from "../web/src/lib/shortcuts.js"

const rows = (groups: ReturnType<typeof shortcutGroups>) => groups.flatMap((g) => g.rows)
const row = (groups: ReturnType<typeof shortcutGroups>, id: string) => rows(groups).find((r) => r.id === id)

describe("chord text", () => {
  it("runs a Mac's modifier symbols together and joins words with + elsewhere", () => {
    expect(chordText(["⌘", "K"], true)).toBe("⌘K")
    expect(chordText(["⌥", "⇧", "C"], true)).toBe("⌥⇧C")
    expect(chordText(["Ctrl", "K"], false)).toBe("Ctrl+K")
    expect(chordText(["Alt", "Shift", "V"], false)).toBe("Alt+Shift+V")
    expect(chordText(["Esc"], false)).toBe("Esc")
    expect(chordLabel(voiceChord, true)).toBe("⌥⇧V")
    expect(chordLabel(paletteChord, false)).toBe("Ctrl+K")
  })

  it("says symbols as words for a screen reader", () => {
    expect(spokenChord(["⌥", "⇧", "C"])).toBe("Option+Shift+C")
    expect(spokenChord(["⌘", "Enter"])).toBe("Command+Enter")
    expect(spokenChord(["Esc"])).toBe("Escape")
    expect(spokenChord(["↑"])).toBe("Up arrow")
  })

  it("draws the dictation setting's chord, or nothing when it's off", () => {
    expect(dictationChord("alt+space", true)).toEqual(["⌥", "Space"])
    expect(dictationChord("ctrl+shift+space", false)).toEqual(["Ctrl", "Shift", "Space"])
    expect(dictationChord("off", true)).toBeNull()
  })
})

describe("shortcutGroups", () => {
  it("uses ⌘ and ⌥⇧ on a Mac, Ctrl and Alt+Shift elsewhere", () => {
    const mac = shortcutGroups({ mac: true, dictation: null })
    const pc = shortcutGroups({ mac: false, dictation: null })
    expect(row(mac, "palette")!.keys).toEqual([["⌘", "K"], ["/"]])
    expect(row(pc, "palette")!.keys).toEqual([["Ctrl", "K"], ["/"]])
    expect(row(mac, "composer")!.keys).toEqual([["⌥", "⇧", "C"]])
    expect(row(pc, "voice")!.keys).toEqual([["Alt", "Shift", "V"]])
    expect(row(mac, "new-tab")!.keys).toEqual([["⌘", "Enter"]])
    expect(row(pc, "newline")!.keys).toEqual([["Shift", "Enter"]])
  })

  it("lists dictation with the chord from Settings, held, and leaves it out when there's none", () => {
    expect(row(shortcutGroups({ mac: true, dictation: "alt+space" }), "dictate")).toMatchObject({ keys: [["⌥", "Space"]], hold: true })
    expect(row(shortcutGroups({ mac: false, dictation: "ctrl+space" }), "dictate")!.keys).toEqual([["Ctrl", "Space"]])
    expect(row(shortcutGroups({ mac: true, dictation: null }), "dictate")).toBeUndefined()
    expect(row(shortcutGroups({ mac: true, dictation: "off" }), "dictate")).toBeUndefined()
  })

  it("lists the palette's prefixes and gives every row a key and a unique id", () => {
    const groups = shortcutGroups({ mac: false, dictation: "ctrl+space" })
    expect(row(groups, "narrow")).toMatchObject({ label: "Narrow to commands, PRs, files or projects", keys: [[">"], ["#"], ["f:"], ["p:"]] })
    const ids = rows(groups).map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const r of rows(groups)) expect(r.keys.length && r.keys.every((c) => c.length > 0)).toBeTruthy()
    expect(groups.map((g) => g.title)).toEqual(["Anywhere", "Sidebar", "Composer", "Command palette", "File preview", "Settings"])
  })
})

describe("hotkeys", () => {
  const ev = (init: Partial<KeyboardEvent> & { target?: EventTarget | null } = {}) =>
    ({ key: "?", code: "Slash", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true, defaultPrevented: false, repeat: false, isComposing: false, target: document.body, ...init }) as KeyboardEvent

  it('"?" opens the sheet from anywhere but a text field, with or without Shift', () => {
    expect(isShortcutsKey(ev())).toBe(true)
    expect(isShortcutsKey(ev({ shiftKey: false }))).toBe(true)
    expect(isShortcutsKey(ev({ key: "/" }))).toBe(false)
    for (const init of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }, { repeat: true }, { isComposing: true }, { defaultPrevented: true }])
      expect(isShortcutsKey(ev(init))).toBe(false)
    for (const tag of ["input", "textarea", "select"]) expect(isShortcutsKey(ev({ target: document.createElement(tag) }))).toBe(false)
  })

  it("⌥⇧C goes by key position, so a Mac's Option letter doesn't matter", () => {
    expect(isComposerJumpKey(ev({ key: "Ç", code: "KeyC", altKey: true, shiftKey: true }))).toBe(true)
    expect(isComposerJumpKey(ev({ key: "C", code: "KeyC", altKey: true, shiftKey: false }))).toBe(false)
    expect(isComposerJumpKey(ev({ key: "C", code: "KeyC", altKey: true, shiftKey: true, metaKey: true }))).toBe(false)
    expect(isComposerJumpKey(ev({ key: "V", code: "KeyV", altKey: true, shiftKey: true }))).toBe(false)
  })
})

describe("composerJumpTarget", () => {
  afterEach(() => {
    document.body.innerHTML = ""
  })

  // The page's shape: the chat's footer composer, a card's reply box in the transcript, and the side panel.
  function page({ panel = true, covered = false } = {}) {
    document.body.innerHTML = `
      <section data-testid="chat-panel">
        <div data-testid="transcript"><textarea data-testid="card-reply"></textarea><a href="#" data-testid="link">link</a></div>
        <div data-testid="chat-footer"><textarea data-testid="chat"></textarea></div>
        ${panel ? `<aside data-testid="side-thread" style="${covered ? "position: absolute" : ""}">
          <div role="dialog"><button data-testid="back">Back</button><textarea data-testid="queued"></textarea>
          <div><textarea data-testid="panel"></textarea></div></div>
        </aside>` : ""}
      </section>`
    const $ = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!
    return $
  }

  it("lands in the chat's composer from the page, and in the panel's from inside the panel", () => {
    const $ = page()
    expect(composerJumpTarget(document.body)).toBe($("chat"))
    expect(composerJumpTarget($("link"))).toBe($("chat"))
    expect(composerJumpTarget($("card-reply"))).toBe($("chat"))
    expect(composerJumpTarget($("back"))).toBe($("panel"))
    expect(composerJumpTarget($("queued"))).toBe($("panel"))
  })

  it("hops between the chat's composer and the panel's", () => {
    const $ = page()
    expect(composerJumpTarget($("chat"))).toBe($("panel"))
    expect(composerJumpTarget($("panel"))).toBe($("chat"))
  })

  it("stays put with no panel, and skips the chat's composer while a sheet covers it", () => {
    let $ = page({ panel: false })
    expect(composerJumpTarget(document.body)).toBe($("chat"))
    expect(composerJumpTarget($("chat"))).toBeNull()
    $ = page({ covered: true })
    expect(composerJumpTarget(document.body)).toBe($("panel"))
    expect(composerJumpTarget($("panel"))).toBeNull()
  })

  it("skips a disabled composer", () => {
    const $ = page()
    ;($("panel") as HTMLTextAreaElement).disabled = true
    expect(composerJumpTarget($("chat"))).toBeNull()
    expect(composerJumpTarget($("back"))).toBe($("chat"))
  })
})
