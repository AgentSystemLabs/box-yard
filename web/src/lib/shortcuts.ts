// Every keyboard shortcut the app has, in one list. The "?" sheet (components/ShortcutsHelp.tsx) shows it, and the
// buttons that have a hotkey take their tooltip's key text from here, so the sheet and the tooltips never disagree.
// The handlers stay where they are (the palette, the chat switcher, voice, dictation, the file preview); only the
// composer jump (⌥⇧C) and the sheet's own "?" are new, and both live in ShortcutsHelp.tsx.
//
// The jump's two stops are the centre chat's composer and the side panel's. From the panel (anywhere in it) the
// first press lands in the panel's composer, from anywhere else in the chat's, and each press after that hops to the
// other one. A panel drawn as a sheet over the chat (a narrow window) hides the chat's composer, so it isn't a stop.
import { PREFIXES } from "./paletteRank"
import type { DictationKey } from "./dictation"

/** One chord: its key caps, pressed together ("⌘", "K"). */
export type Chord = string[]

export interface Shortcut {
  id: string
  label: string
  /** Alternatives: any one of them does it. */
  keys: Chord[]
  /** Held down rather than pressed (dictation's push-to-talk). */
  hold?: boolean
}

export interface ShortcutGroup {
  title: string
  rows: Shortcut[]
}

/** The key caps a Mac shows, and everything else. */
const CAPS = {
  mac: { mod: "⌘", alt: "⌥", shift: "⇧", ctrl: "⌃" },
  other: { mod: "Ctrl", alt: "Alt", shift: "Shift", ctrl: "Ctrl" },
}

const capsFor = (mac: boolean) => (mac ? CAPS.mac : CAPS.other)

/** ⌘K, or Ctrl+K on Windows and Linux: the way a tooltip writes a chord. Plain words ("Esc") read on their own. */
export function chordText(chord: Chord, mac: boolean): string {
  return chord.join(mac && chord.slice(0, -1).every((k) => /^[⌘⌥⇧⌃]$/.test(k)) ? "" : "+")
}

const SPOKEN: Record<string, string> = { "⌘": "Command", "⌥": "Option", "⇧": "Shift", "⌃": "Control", "↑": "Up arrow", "↓": "Down arrow", "←": "Left arrow", "→": "Right arrow", "⌫": "Backspace", Esc: "Escape" }

/** A chord as a screen reader should say it: "Option+Shift+C", not "⌥⇧C". */
export const spokenChord = (chord: Chord) => chord.map((k) => SPOKEN[k] ?? k).join("+")

/** A tooltip's text for one of the chords below: chordLabel(voiceChord, true) is "⌥⇧V", and "Alt+Shift+V" elsewhere. */
export const chordLabel = (chord: (mac: boolean) => Chord, mac: boolean) => chordText(chord(mac), mac)

/** The command palette: ⌘K / Ctrl+K. */
export const paletteChord = (mac: boolean): Chord => [capsFor(mac).mod, "K"]

/** The composer jump: ⌥⇧C / Alt+Shift+C, by key position like ⌥⇧V (Option changes the letter on a Mac). */
export const composerChord = (mac: boolean): Chord => [capsFor(mac).alt, capsFor(mac).shift, "C"]

export const sendToChord = (mac: boolean): Chord => [capsFor(mac).mod, capsFor(mac).shift, "Enter"]

/** Voice on or off: ⌥⇧V / Alt+Shift+V (components/VoiceControl.tsx). */
export const voiceChord = (mac: boolean): Chord => [capsFor(mac).alt, capsFor(mac).shift, "V"]

/** The dictation setting as key caps (lib/dictation.ts), or null when it's off. */
export function dictationChord(key: DictationKey, mac: boolean): Chord | null {
  if (key === "off") return null
  const caps = capsFor(mac)
  return key.split("+").map((k) => (k === "alt" ? caps.alt : k === "ctrl" ? caps.ctrl : k === "shift" ? caps.shift : "Space"))
}

export const isComposerJumpKey = (e: Pick<KeyboardEvent, "altKey" | "shiftKey" | "metaKey" | "ctrlKey" | "code">) =>
  e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey && e.code === "KeyC"

const FIELD = "input, textarea, select, [contenteditable=''], [contenteditable=true]"

/** "?" from anywhere but a text field. Not tied to Shift: some layouts type "?" without it. */
export function isShortcutsKey(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "defaultPrevented" | "repeat" | "isComposing" | "target">) {
  if (e.key !== "?" || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || e.repeat || e.isComposing) return false
  const el = e.target instanceof Element ? e.target : null
  return !el?.closest(FIELD)
}

/** "commands, PRs, files or projects". */
const orList = (words: string[]) => (words.length > 1 ? `${words.slice(0, -1).join(", ")} or ${words.at(-1)}` : (words[0] ?? ""))

/**
 * The sheet's list. `dictation`: the push-to-talk setting, or null when dictation is off or this browser can't do it
 * (the row is left out rather than shown as a key that does nothing).
 */
export function shortcutGroups({ mac, dictation }: { mac: boolean; dictation: DictationKey | null }): ShortcutGroup[] {
  const caps = capsFor(mac)
  const talk = dictation && dictationChord(dictation, mac)
  return [
    {
      title: "Anywhere",
      rows: [
        { id: "palette", label: "Search tasks, projects, files and commands", keys: [paletteChord(mac), ["/"]] },
        { id: "switch", label: "Switch chat: the Coordinator or a project's Captain", keys: [["P"]] },
        { id: "composer", label: "Jump to the composer; again to hop between the chat and the panel", keys: [composerChord(mac)] },
        { id: "voice", label: "Turn voice on or off", keys: [voiceChord(mac)] },
        ...(talk ? [{ id: "dictate", label: "Dictate into the composer", keys: [talk], hold: true }] : []),
        { id: "close", label: "Close the panel, dialog or menu", keys: [["Esc"]] },
        { id: "help", label: "Show these shortcuts", keys: [["?"]] },
      ],
    },
    {
      // The sidebar's list is a tree (lib/treeView.ts): one stop for Tab, then these.
      title: "Sidebar",
      rows: [
        { id: "tree-tab", label: "Into the list, on the open chat or task, and out of it", keys: [["Tab"]] },
        { id: "tree-move", label: "Move up or down the list", keys: [["↑"], ["↓"]] },
        { id: "tree-unfold", label: "Unfold, then step into it", keys: [["→"]] },
        { id: "tree-fold", label: "Fold, or step out to the row it's under", keys: [["←"]] },
        { id: "tree-toggle", label: "Fold or unfold; on a row that doesn't fold, open it", keys: [["Space"]] },
        { id: "tree-delete", label: "Reveal actions for a project or task (Escape to close)", keys: [["Shift", "F10"]] },
        { id: "tree-open", label: "Open", keys: [["Enter"]] },
        { id: "tree-ends", label: "First or last row", keys: [["Home"], ["End"]] },
        { id: "tree-find", label: "Jump to a row: type the start of its name", keys: [["A–Z"]] },
      ],
    },
    {
      title: "Composer",
      rows: [
        { id: "send", label: "Send; on a touch screen, Enter adds a line", keys: [["Enter"], [caps.mod, "Enter"]] },
        { id: "send-to", label: "Choose a task, Captain or Coordinator to send this draft to", keys: [[">"], sendToChord(mac)] },
        { id: "newline", label: "New line", keys: [[caps.shift, "Enter"]] },
        { id: "sidebar", label: "Return focus to the current sidebar row, keeping the draft", keys: [["Esc"]] },
        { id: "history", label: "Earlier prompts, in an empty composer", keys: [["↑"], ["↓"]] },
        { id: "where", label: "Choose where its tasks run", keys: [["@"]] },
        { id: "github", label: "Reference a GitHub issue or pull request by number or title", keys: [["#"]] },
        { id: "project", label: "Choose a project in the Coordinator chat", keys: [["%"]] },
        { id: "harness", label: "Choose the agent that runs them", keys: [["!"]] },
      ],
    },
    {
      title: "Command palette",
      rows: [
        { id: "move", label: "Move", keys: [["↑"], ["↓"]] },
        { id: "open", label: "Open", keys: [["Enter"]] },
        { id: "new-tab", label: "Open in a new tab", keys: [[caps.mod, "Enter"]] },
        { id: "narrow", label: `Narrow to ${orList(PREFIXES.map((p) => (/^[A-Z]{2}/.test(p.label) ? p.label : p.label.toLowerCase())))}`, keys: PREFIXES.map((p) => [p.prefix]) },
        { id: "unscope", label: "Remove the filter", keys: [["⌫"]] },
      ],
    },
    {
      title: "File preview",
      rows: [
        { id: "step", label: "Previous or next file", keys: [["←"], ["→"]] },
        { id: "zoom", label: "Zoom an image", keys: [["Z"]] },
      ],
    },
    {
      title: "Settings",
      rows: [{ id: "find", label: "Search settings", keys: [["/"], [caps.mod, "F"]] }],
    },
  ]
}

// ---------------------------------------------------------------- the composer jump

const CHAT_COMPOSER = '[data-testid="chat-footer"] textarea'
const PANEL = 'aside[data-testid="side-thread"]'

const usable = (el: HTMLTextAreaElement | null | undefined): el is HTMLTextAreaElement =>
  Boolean(el && !el.disabled && (el.checkVisibility?.() ?? true))

/**
 * The jump's stops on screen: the centre chat's composer and the side panel's (the last one in it: its footer's,
 * below any queued message being edited). The chat's isn't one while the panel is a sheet covering the chat.
 */
export function composerStops(root: ParentNode = document): { chat: HTMLTextAreaElement | null; panel: HTMLTextAreaElement | null; aside: HTMLElement | null } {
  const aside = root.querySelector<HTMLElement>(PANEL)
  const covered = Boolean(aside && getComputedStyle(aside).position === "absolute")
  // The one on screen: the centre keeps the chats left last hidden beside it, composers and all (lib/keptChats.ts).
  const chat = [...root.querySelectorAll<HTMLTextAreaElement>(CHAT_COMPOSER)].find((t) => !aside?.contains(t) && usable(t))
  const panel = aside ? [...aside.querySelectorAll<HTMLTextAreaElement>("textarea")].at(-1) : null
  return { chat: !covered && chat ? chat : null, panel: usable(panel) ? panel : null, aside }
}

/** Where ⌥⇧C goes from `active`: the other stop from one of them, else the one for the part of the page it's in. */
export function composerJumpTarget(active: Element | null, root: ParentNode = document): HTMLTextAreaElement | null {
  const { chat, panel, aside } = composerStops(root)
  if (active && active === chat) return panel
  if (active && active === panel) return chat
  if (active && aside?.contains(active)) return panel ?? chat
  return chat ?? panel
}
