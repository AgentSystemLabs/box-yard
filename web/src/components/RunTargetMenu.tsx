// The picks in the Coordinator and Captain composers (shared/runTargets.ts): where the message's tasks run ("@"), which
// harness (agent CLI) runs them ("!") and, in the Coordinator's chat only, which project the message is for ("%").
// The pick always lives in the text, as "@token" / "!token" / "%token", so the text and what's sent never disagree:
// - typing: "@" opens the list of places, "!" the list of harnesses, "%" the list of projects, filtered as Cody types;
//   ↑/↓ move, Enter or Tab picks, Esc backs out a level or closes, a tap picks.
// - the Where, Harness and Project buttons in the composer's row of icons (the main way on a phone) put that trigger at
//   the caret and open the same list, so using them teaches the typed shortcut. When the draft already names a pick of
//   that kind, the button selects its word instead: the list offers the others, and picking one replaces it.
//   Where and Harness open a sheet with a search field (PickerSheet): words find any level at once ("fable high",
//   shared/runTargetSearch.ts), a tap drills; the phone keyboard waits for a tap on the field.
// The Composer sends the picks as the message's meta.runsOn / meta.agent / meta.project; sent messages show them as
// chips. Default says what it means (in the buttons' names and the list's header): in a Captain's chat its project's
// own Runs on and agent, in the Coordinator's each project's.
// A pick typed inside one item of a list of tasks ("9. … !claude") is only that item's (shared/runTargets.ts
// scopePicks): it goes as meta.inlinePicks, a hint the turn's prompt lists, and Box Yard doesn't apply it to the
// other tasks. The buttons are the whole message's, so in a list their trigger goes at the message's start; the line
// over them (PickScope) and the sent message's dashed chips say which picks are only their part's.
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react"
import { createPortal, flushSync } from "react-dom"
import { AlertTriangle, Asterisk, Box, BrainCircuit, ChevronRight, Container, Cpu, FolderGit2, MapPin, Monitor, MousePointer2, Network, Server, SquareTerminal, Tag, type LucideIcon } from "lucide-react"
import { cx } from "./ui"
import { ComposerMenuItem } from "./ComposerMenu"
import { Loading } from "./Loading"
import { DismissButton } from "./Modal"
import { PickerSheet, groupTogether } from "./PickerSheet"
import { useAbove } from "../lib/useAbove"
import { pickerKeyDown } from "../lib/pickerKeys"
import { useAgentSettings, useCursorModels, useHarnessTargets, useModelCatalog, useProjectRunDefaults, useProjectTargets, useRefreshPicker, useRunTargets } from "../lib/queries"
import { CURSOR_FALLBACK_MODELS } from "../../../shared/agentCli"
import { harnessDefaults } from "../../../shared/harnessDefaults"
import { harnessModelTargets } from "../../../shared/harnessPicks"
import { MODEL_GROUP_LABEL } from "../../../shared/models"
import { searchRunTargets } from "../../../shared/runTargetSearch"
import {
  advancesInto,
  drillsInto,
  filterRunTargets,
  inlinePicksFrom,
  inlinePicksOf,
  insertRunTarget,
  listItems,
  mentionAt,
  pickConflict,
  pickOf,
  projectHarnessTarget,
  projectRunTarget,
  runTargetPickOf,
  runTargetParent,
  scopePicks,
  TAG_TRIGGER,
  tokensIn,
  type InlinePick,
  type InlineReason,
  type PickKind,
  type PickTrigger,
  type PlacedPick,
  type RunTarget,
  type RunTargetPick,
  type ScopedPick,
  type TagKind,
} from "../../../shared/runTargets"

const ICON: Record<string, LucideIcon> = {
  local: Monitor,
  "this-computer": Monitor,
  box: Box,
  docker: Container,
  gpu: Cpu,
  ssh: Network,
  claude: Asterisk,
  codex: SquareTerminal,
  cursor: MousePointer2,
  opencode: SquareTerminal,
}
const iconOf = (t: Pick<RunTarget, "kind" | "token">): LucideIcon =>
  t.kind === "machine" ? Server : t.kind === "label" ? Tag : t.kind === "project" ? FolderGit2 : t.kind === "gpu" || t.token.startsWith("gpu:") ? Cpu : (ICON[t.token.split(":")[0]!] ?? MapPin)

/** A list (and its button): where the tasks run, their harness, or (the Coordinator's) the project. */
export type ListKind = TagKind
const TRIGGER = TAG_TRIGGER
/** A button's icon while nothing of its kind is picked. */
const DEFAULT_ICON: Record<ListKind, LucideIcon> = { runsOn: MapPin, agent: BrainCircuit, project: FolderGit2 }
const LIST_TITLE: Record<ListKind, string> = {
  runsOn: "Where this message's tasks run",
  agent: "Which harness runs this message's tasks",
  project: "Which project this message is for",
}
/** The title while the "@word" is typed in one item of a list of tasks. */
const ITEM_TITLE: Record<ListKind, (item: string) => string> = {
  runsOn: (item) => `Where ${item}'s task runs`,
  agent: (item) => `Which harness runs ${item}'s task`,
  project: (item) => `Which project ${item} is for`,
}
const BUTTON_NAME: Record<ListKind, string> = { runsOn: "Where tasks run", agent: "Harness", project: "Project" }
/** The project setting Default follows. */
const SETTING: Record<PickKind, string> = { runsOn: "Runs on", agent: "agent" }

/** A message's picks, as onSubmit gets them: the whole message's, and the ones for only part of it. */
export interface ChatPicks {
  runsOn?: RunTargetPick
  agent?: RunTargetPick
  /** The Coordinator's "%": the project's Captain should get it. */
  project?: RunTargetPick
  /** Picks typed for one item of a list of tasks (or that disagree): hints the turn's prompt lists, never applied. */
  inline?: InlinePick[]
}

type ByKind<T> = Record<PickKind, T>

/** What the Composer needs: key handling, the textarea's combobox attributes, the typed list, the buttons' state. */
export interface ChatPicksState {
  /** Call first in the textarea's onKeyDown: true when the menu took the key (Enter picks instead of sending). */
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean
  /** The textarea's caret moved, it got or lost focus. */
  onCaret: () => void
  onFocus: (focused: boolean) => void
  /** combobox attributes for the textarea, while the list is on. */
  inputProps: Record<string, string | boolean | undefined>
  open: boolean
  /** Button picks use a focusable sheet; typed mentions keep their combobox list. */
  panel: boolean
  close: () => void
  /**
   * The shared list: its kind, options, the highlighted one and the pick action, for <RunTargetList>. `opens` says
   * which options open what's under them (a GPU cloud's GPUs) rather than pick.
   */
  list: {
    id: string
    kind: ListKind
    options: RunTarget[]
    loading: boolean
    error: boolean
    active: number
    pick: (t: RunTarget) => void
    setActive: (i: number) => void
    note: string | null
    opens: (t: RunTarget) => boolean
    /** The drill-down open now (a harness's models, a box's sizes): its header shows Back. */
    parent?: RunTarget
    back: () => void
    /** The list item the "@word" is typed in ("item 9"), when the draft is a list of tasks: the pick is only that item's. */
    item: string | null
    /** Breadcrumb segments for the open level (Harness › Cursor). */
    trail: string[]
    /** The button sheet's search words ("fable high"); empty while typing in the draft. */
    panelQuery: string
    setPanelQuery: (query: string) => void
    /** The sheet's heading for each option ("Latest", "Claude Code · Aliases"), "" for none; empty for the typed list. */
    groups: string[]
  }
  /** The whole message's picks now: the "@token" / "!token" / "%token" in the draft that's for all of it (scopePicks). */
  picked: Record<ListKind, RunTarget | null>
  /** Every pick typed in the draft, with what it's for: the whole message, or only its part (scopePicks). */
  scoped: ScopedPick[]
  /** The lists a tag in the draft can name (shared/runTargets.ts tagsIn): only the kinds this chat has, once loaded. */
  lists: Partial<Record<ListKind, RunTarget[] | undefined>>
  /** What Default is in a Captain's chat (its project's Runs on and agent, greyed out when it can't run there); null in the Coordinator's or while loading. */
  defaults: ByKind<RunTarget | null>
  /** The Captain's project, once loaded. */
  projectName: string | null
  /** Why they can't be sent together (Codex on an SSH machine), or null. Sending waits until it's fixed. */
  conflict: string | null
  /** What a send carries. */
  extra: () => ChatPicks
  /** The kinds with a button: Where and Harness, and Project in the Coordinator's chat. */
  kinds: ListKind[]
  /** A button's press: its trigger in the draft (or its existing pick selected), and its panel/list open. */
  insert: (kind: ListKind) => void
  /** Whose lists: a project's Captain, or null for the Coordinator. */
  projectId: string | null
}

const NO_DEFAULTS: ByKind<RunTarget | null> = { runsOn: null, agent: null }
const NO_LISTS: ChatPicksState["lists"] = {}
const NONE: PlacedPick[] = []
const NO_SCOPED: ScopedPick[] = []

/** A draft's typed picks of one kind (a greyed-out one too, but not for "%"), for scopePicks. */
const placedIn = (text: string, targets: RunTarget[], trigger: PickTrigger, kind: ListKind, disabledToo = true): PlacedPick[] =>
  tokensIn(text, targets, trigger, disabledToo).map((p) => ({ ...p, kind }))

/** The item of a list of tasks (two or more items) that `at` is in, as "item 9"; null outside one, or with no list. */
function itemOf(text: string, at: number): string | null {
  const items = listItems(text)
  if (items.length < 2) return null
  return items.find((i) => at >= i.start && at <= i.end)?.label ?? null
}
const NO_GROUPS: string[] = []
const NO_OPTIONS: { options: RunTarget[]; groups: string[] } = { options: [], groups: NO_GROUPS }
const CAPTAIN_KINDS: ListKind[] = ["runsOn", "agent"]
const COORDINATOR_KINDS: ListKind[] = ["project", "runsOn", "agent"]

/**
 * The picks' state for a composer's draft. `enabled` false: nothing (task chats, side threads). "%" is on only in the
 * Coordinator's chat (`projectId` null). A list is fetched on mount into the shared query cache. Focusing refreshes
 * stale lists in the background; the harness list is for where the tasks run. No network/availability check holds a
 * menu closed, except "%": it opens only once the projects are there and one matches, so ordinary percent signs stay text.
 */
export function useChatPicks({
  enabled,
  projectId,
  value,
  setValue,
  input,
}: {
  enabled: boolean
  projectId: string | null
  value: string
  setValue: (v: string) => void
  input: RefObject<HTMLTextAreaElement | null>
}): ChatPicksState {
  const [focused, setFocused] = useState(false)
  const [panel, setPanel] = useState(false)
  const projectOn = enabled && projectId === null
  const hasAt = enabled && value.includes("@")
  const hasBang = enabled && value.includes("!")
  const hasProject = projectOn && value.includes("%")
  const placesQuery = useRunTargets(projectId, enabled, focused ? "focus" : hasAt ? "mention" : null)
  const places = placesQuery.data
  // Each kind's typed picks; the whole message's "@" one says where the "!" list checks the harnesses.
  const atPlaced = useMemo(() => (hasAt && places ? placedIn(value, places, "@", "runsOn") : NONE), [hasAt, places, value])
  const typedRunsOn = useMemo(() => (atPlaced.length ? scopePicks(value, atPlaced).wide.runsOn : null), [atPlaced, value])
  const runsOn = enabled ? typedRunsOn : null
  const harnessQuery = useHarnessTargets(projectId, runsOn?.value ?? null, enabled, focused ? "focus" : hasBang ? "mention" : null)
  const lastHarnesses = useRef<RunTarget[] | undefined>(undefined)
  useEffect(() => {
    if (harnessQuery.data && !harnessQuery.isPlaceholderData) lastHarnesses.current = harnessQuery.data
  }, [harnessQuery.data, harnessQuery.isPlaceholderData])
  // A different location's availability isn't evidence for this one. Keep its rows visible, but wait to pick them.
  const availableHarnesses = useMemo(() => harnessQuery.isPlaceholderData || !harnessQuery.data
    ? (harnessQuery.data ?? lastHarnesses.current)?.map((t) => ({ ...t, disabled: harnessQuery.error ? "Couldn't check availability for this location" : "Checking availability for this location…" }))
    : harnessQuery.data, [harnessQuery.data, harnessQuery.isPlaceholderData, harnessQuery.error])
  // Catalogs load only when a harness tag is in the draft. The built-in lists keep typing and picking immediate.
  const settings = useAgentSettings({ enabled: hasBang }).data?.settings
  const claudeModels = useModelCatalog(hasBang)
  const cursorModels = useCursorModels(hasBang)
  const harnesses = useMemo(() => availableHarnesses && harnessModelTargets(availableHarnesses, {
    defaults: harnessDefaults(settings),
    claude: claudeModels.data?.models,
    cursor: cursorModels.data?.models ?? CURSOR_FALLBACK_MODELS,
  }), [availableHarnesses, settings?.agentModel, settings?.agentEffort, settings?.agentCodexModel, settings?.agentCodexEffort, settings?.agentCursorModel, settings?.agentOpencodeModel, claudeModels.data?.models, cursorModels.data?.models])
  const projects = useProjectTargets(projectOn)
  const refreshPicker = useRefreshPicker(projectId)
  const bangPlaced = useMemo(() => (hasBang && harnesses ? placedIn(value, harnesses, "!", "agent") : NONE), [hasBang, harnesses, value])
  const projectPlaced = useMemo(() => (hasProject && projects ? placedIn(value, projects, "%", "project", false) : NONE), [hasProject, projects, value])
  // Which are the whole message's and which only one item's: one parse for the buttons, the send and the scope line.
  const scoped = useMemo(
    () => (atPlaced.length || bangPlaced.length || projectPlaced.length ? scopePicks(value, [...atPlaced, ...bangPlaced, ...projectPlaced]) : null),
    [atPlaced, bangPlaced, projectPlaced, value],
  )
  const agent = enabled ? (scoped?.wide.agent ?? null) : null
  const project = scoped?.wide.project ?? null
  // A Captain's Default is its project's own Runs on and agent, checked against the lists for where its tasks go now.
  const own = useProjectRunDefaults(enabled ? projectId : null)
  const checkedHarnesses = harnessQuery.isPlaceholderData ? undefined : harnessQuery.data
  const defaults = useMemo<ByKind<RunTarget | null>>(
    () => (own ? { runsOn: projectRunTarget(places, own.runner, own.machineLabel), agent: projectHarnessTarget(checkedHarnesses, own.agentCli) } : NO_DEFAULTS),
    [own, places, checkedHarnesses],
  )
  const conflict = runsOn?.disabled ? `${runsOn.disabled} (you picked @${runsOn.token}): pick another place.` : pickConflict(runsOn, agent)

  const [caret, setCaret] = useState(0)
  const [active, setActive] = useState(0)
  // Esc closes the list for the "@word" it was on; a new "@" (or "!", "%") opens it again.
  const [dismissed, setDismissed] = useState<number | null>(null)
  // The button sheet's own search field: it never moves the draft's caret.
  const [panelQuery, setPanelQuery] = useState("")
  const id = useId()

  const at = Math.min(caret, value.length)
  const atMention = hasAt ? mentionAt(value, at, "@") : null
  const bangMention = !atMention && hasBang ? mentionAt(value, at, "!") : null
  const projectMention = !atMention && !bangMention && hasProject ? mentionAt(value, at, "%") : null
  const mention = atMention ?? bangMention ?? projectMention
  const kind: ListKind = bangMention ? "agent" : projectMention ? "project" : "runsOn"
  const lists: Record<ListKind, RunTarget[] | undefined> = { runsOn: places, agent: harnesses, project: projects }
  // A Captain's chat has no "%", though the projects may be in the cache.
  const tagLists = useMemo(() => (enabled ? { runsOn: places, agent: harnesses, project: projectOn ? projects : undefined } : NO_LISTS), [enabled, projectOn, places, harnesses, projects])
  const source = lists[kind]
  const parent = mention && source ? runTargetParent(source, mention.query) : undefined
  // The typed list filters by the token after its trigger. The sheet shows the open level, or what its search words
  // name at any level under it ("fable high"), kept together under the sheet's headings.
  const searching = panel && Boolean(panelQuery.trim())
  const { options, groups } = useMemo(() => {
    if (!mention || !source) return NO_OPTIONS
    if (!panel) return { options: filterRunTargets(source, mention.query), groups: NO_GROUPS }
    // Headings: a browsed level's own groups (a harness's Latest, Aliases, Older). Search results are few, so they
    // stand under their harness's name only, and a row says itself what it is (SheetRow's "alias", "older").
    const groupOf = (t: RunTarget) => {
      if (kind !== "agent" || !t.under || t.token === parent?.token || parent?.under) return ""
      if (!searching) return t.group ?? ""
      return parent ? "" : (source.find((h) => h.token === t.token.split(":")[0])?.label ?? "")
    }
    const options = searching ? groupTogether(searchRunTargets(source, panelQuery, parent), groupOf) : filterRunTargets(source, parent?.token ?? "")
    return { options, groups: options.map(groupOf) }
  }, [mention?.query, source, panel, searching, panelQuery, parent, kind]) // eslint-disable-line react-hooks/exhaustive-deps
  // "%" waits for a match: ordinary percent text never opens an empty or loading list.
  const showable = kind === "project" ? options.length > 0 || Boolean(panelQuery) : !source || options.length > 0 || Boolean(panelQuery)
  const open = Boolean(enabled && (panel || (focused && showable)) && mention && dismissed !== mention.start)
  const close = () => {
    setPanel(false)
    setPanelQuery("")
    if (mention) setDismissed(mention.start)
  }
  const errors: Record<ListKind, boolean> = { runsOn: Boolean(placesQuery.error), agent: Boolean(harnessQuery.error), project: false }
  // Typed inside one item of a list of tasks: the pick is that item's only, and the list says so.
  const mentionItem = useMemo(() => (mention ? itemOf(value, mention.start) : null), [mention?.start, value]) // eslint-disable-line react-hooks/exhaustive-deps
  const firstEnabled = Math.max(0, options.findIndex((t) => !t.disabled))
  // A new filter highlights its first pickable option.
  useEffect(() => setActive(firstEnabled), [mention?.query, panelQuery, mention?.start, kind, firstEnabled])
  useEffect(() => {
    if (dismissed !== null && mention?.start !== dismissed) setDismissed(null)
  }, [mention?.start, dismissed])
  // A new drill level (or closing the sheet) drops the sheet's own filter.
  useEffect(() => {
    setPanelQuery("")
  }, [parent?.token, panel])

  // Only on a move: the select event after each keystroke reports the caret its input already did, and a same-value
  // setState right after a render still costs the Composer a commit.
  const caretAt = useRef(0)
  const moveCaret = useCallback((at: number) => {
    if (at === caretAt.current) return
    caretAt.current = at
    setCaret(at)
  }, [])
  const onCaret = useCallback(() => moveCaret(input.current?.selectionStart ?? 0), [input, moveCaret])

  const pick = useCallback(
    (t: RunTarget, forceDrill = false) => {
      const el = input.current
      if (!el || t.disabled) return
      const trigger = t.kind === "harness" ? "!" : t.kind === "project" ? "%" : "@"
      const m = mentionAt(el.value, el.selectionStart ?? el.value.length, trigger)
      if (!m) return
      // A GPU cloud with GPUs under it opens them first: picking it again (or "any GPU" on it) then picks it.
      // Tab/Space on an exact parent (`!cursor`) force a drill so the next letters filter models.
      const targets = trigger === "!" ? harnesses : places
      const drill = forceDrill || (trigger !== "%" && Boolean(targets) && drillsInto(t, targets!, m.query))
      const next = insertRunTarget(el.value, m, t.token, trigger, drill)
      flushSync(() => setValue(next.value))
      if (!panel || !drill) el.focus()
      el.setSelectionRange(next.caret, next.caret)
      moveCaret(next.caret)
      setPanelQuery("")
      if (!drill) setPanel(false)
    },
    [input, setValue, moveCaret, places, harnesses, panel],
  )
  const opens = useCallback((t: RunTarget) => kind !== "project" && Boolean(source && mention) && drillsInto(t, source!, mention!.query), [kind, source, mention?.query]) // eslint-disable-line react-hooks/exhaustive-deps

  const back = () => {
    const el = input.current
    if (!el || !mention || !parent) return
    const next = insertRunTarget(el.value, mention, parent.under ?? "", TRIGGER[kind], true)
    flushSync(() => setValue(next.value))
    if (!panel) el.focus()
    el.setSelectionRange(next.caret, next.caret)
    moveCaret(next.caret)
    setPanelQuery("")
  }

  // A button: the trigger the caret is already in (its list opens again); else the draft's own pick of that kind, its
  // word selected so the list offers the others (typing filters, picking replaces it); else the trigger at the caret,
  // spaced from the words around it. The list opens either way.
  const insert = useCallback(
    (k: ListKind) => {
      const el = input.current
      if (!el) return
      const text = el.value
      const trigger = TRIGGER[k]
      // The button is the whole message's pick: its token is the one scopePicks gives the message, not an item's.
      const all = lists[k] ? placedIn(text, lists[k]!, trigger, k) : []
      const named = all.length ? scopePicks(text, all).picks.filter((p) => p.scope === "message").at(-1) : undefined
      let from: number
      let to: number
      let start = el.selectionStart ?? text.length
      let end = el.selectionEnd ?? start
      // Already typing one ("@bo", a second press): open its list again rather than add another.
      const typing = start === end ? mentionAt(text, start, trigger) : null
      if (typing) {
        from = to = start
      } else if (named) {
        from = named.start + 1
        to = named.end
      } else {
        // In a list of tasks, a pick typed in an item is only that item's: the whole message's goes at its start.
        if (itemOf(text, start)) start = end = 0
        const before = text.slice(0, start)
        const after = text.slice(end)
        const lead = before && !/[\s(["']$/.test(before) ? " " : ""
        const trail = after && !/^\s/.test(after) ? " " : ""
        flushSync(() => setValue(before + lead + trigger + trail + after))
        from = to = before.length + lead.length + 1
      }
      if (k === "project") el.focus()
      el.setSelectionRange(from, to)
      setDismissed(null)
      setPanel(k !== "project")
      moveCaret(from)
      if (k !== "project") refreshPicker(k, runsOn?.value ?? null)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [input, setValue, moveCaret, places, harnesses, projects, refreshPicker, runsOn?.value],
  )

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (panel) return false
    if (!open || !mention) return false
    if (e.nativeEvent.isComposing || e.key === "Process") return false
    // Tab/Space on an exact parent (`!cursor`) advance into models so the next letters filter; Enter still picks Default.
    if (e.key === "Tab" || e.key === " ") {
      if (!source) {
        e.preventDefault()
        return true
      }
      const t = options[active]
      if (t && !t.disabled && advancesInto(t, source, mention.query)) {
        e.preventDefault()
        pick(t, true)
        return true
      }
      if (e.key === " ") return false
    }
    return pickerKeyDown(e, {
      options,
      active,
      setActive,
      disabled: (t) => Boolean(t.disabled),
      pick,
      escape: () => (parent ? back() : setDismissed(mention.start)),
    })
  }

  const extra = (): ChatPicks => {
    const inline = enabled && scoped ? inlinePicksFrom(value, scoped) : []
    return {
      ...(project ? { project: pickOf(project) } : {}),
      ...(runsOn && !runsOn.disabled ? { runsOn: pickOf(runsOn) } : {}),
      ...(agent && !agent.disabled ? { agent: pickOf(agent) } : {}),
      ...(inline.length ? { inline } : {}),
    }
  }

  const projectName = own?.name ?? null
  const note = mentionItem
    ? `only ${mentionItem}'s, not the whole message's`
    : kind === "project"
      ? "its Captain gets it"
      : `Default: ${defaultWords(kind, { defaults, projectId, projectName })}${defaults[kind]?.disabled ? ` (${defaults[kind]!.disabled})` : ""}`
  const trail = useMemo(() => {
    if (!parent || !source) return [mentionItem ? ITEM_TITLE[kind](mentionItem) : LIST_TITLE[kind]]
    const stack: string[] = []
    let at: RunTarget | undefined = parent
    while (at) {
      stack.unshift(at.menuLabel ?? at.label)
      at = at.under ? source.find((t) => t.token === at!.under) : undefined
    }
    // Short kind noun + ancestry: "Harness › Cursor › DeepSeek V3"
    const noun = kind === "agent" ? "Harness" : kind === "project" ? "Project" : "Where"
    return [noun, ...stack]
  }, [kind, parent, source, mentionItem])
  const listId = `${id}-picks`
  const optionId = (i: number) => `${listId}-${i}`
  return {
    onKeyDown,
    onCaret,
    onFocus: (on) => {
      setFocused(on)
      if (on) setPanel(false)
    },
    inputProps: enabled
      ? {
          role: "combobox",
          "aria-autocomplete": "list",
          "aria-haspopup": "listbox",
          "aria-expanded": open && !panel,
          "aria-controls": open && !panel ? listId : undefined,
          "aria-activedescendant": open && !panel && options[active] ? optionId(active) : undefined,
        }
      : {},
    open,
    panel,
    close,
    list: {
      id: listId,
      kind,
      options,
      loading: !source,
      error: errors[kind],
      active,
      pick,
      setActive,
      note,
      opens,
      item: mentionItem,
      parent,
      back,
      trail,
      panelQuery,
      setPanelQuery,
      groups,
    },
    picked: { runsOn, agent, project },
    scoped: enabled ? (scoped?.picks ?? NO_SCOPED) : NO_SCOPED,
    lists: tagLists,
    defaults,
    projectName,
    conflict,
    extra,
    kinds: !enabled ? [] : projectOn ? COORDINATOR_KINDS : CAPTAIN_KINDS,
    insert,
    projectId,
  }
}

/** The panel both lists sit in: over the composer's box, portalled with a fixed position so a clipping footer can't cut it. */
const PANEL = "@container/menu fixed z-50 flex flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 shadow-xl shadow-black/40"
const ROW = "mx-1 flex min-h-11 w-[calc(100%-0.5rem)] cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm"

/** One target's icon, "@token", what it is and its second line (or why it can't be picked); a › when it opens more. */
function TargetRow({ t, on, trigger, opens }: { t: RunTarget; on: boolean; trigger: PickTrigger; opens: boolean }) {
  const Icon = iconOf(t)
  return (
    <>
      <Icon className={cx("h-4 w-4 shrink-0", on && !t.disabled ? "text-yard-400" : "text-zinc-500")} aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-2">
          {t.menuLabel ? <span className="min-w-0 truncate text-zinc-100">{t.menuLabel}</span> : <>
            <span className="min-w-0 truncate font-mono text-[13px] text-zinc-100">{trigger}{t.token}</span>
            {t.label.toLowerCase() !== t.token && <span className="min-w-0 truncate text-zinc-400">{t.label}</span>}
          </>}
        </span>
        <span className={cx("min-w-0 truncate text-xs", t.disabled ? "text-amber-300/80" : "text-zinc-500")}>{t.disabled ?? t.detail}</span>
      </span>
      {opens && <ChevronRight data-testid="run-target-opens" className="h-4 w-4 shrink-0 text-zinc-500" aria-label="More options" />}
    </>
  )
}

/** ↑↓ · Tab/Enter · Esc, in the typed list's header. */
const PICKER_KEYS = "↑↓ move · Tab/Enter pick · Esc back"

/** The typed list ("@", "!" or "%"), just over the composer's box. Its header says what Default is, since the buttons are only icons. */
export function RunTargetList({ list, anchor }: { list: ChatPicksState["list"]; anchor: RefObject<HTMLElement | null> }) {
  const { id, kind, options, loading, error, active, pick, setActive, note, opens, parent, back, trail } = list
  const at = useAbove(anchor)
  // The highlighted row stays in view as ↑/↓ move through a long list.
  useEffect(() => {
    document.getElementById(`${id}-${active}`)?.scrollIntoView?.({ block: "nearest" })
  }, [id, active])
  if (!at) return null
  const heading = trail.join(" › ")
  return createPortal(
    <div
      data-testid="run-target-menu"
      data-kind={kind}
      style={{ left: at.left, width: at.width, bottom: at.bottom }}
      className={PANEL}
      // A press keeps the caret in the text (no blur), on a phone too.
      onMouseDown={(e) => e.preventDefault()}
    >
      <div data-testid="run-target-menu-title" className="flex min-h-11 min-w-0 items-center gap-1.5 border-b border-zinc-800/80 px-2 py-1 text-[11px] text-zinc-500">
        {parent && <DismissButton kind="back" onClick={back} label="Back to choices" className="h-11! w-11! transition-none" />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-zinc-300">{heading}</span>
          <span className="block truncate text-zinc-500">{parent ? PICKER_KEYS : note ? `${note} · ${PICKER_KEYS}` : PICKER_KEYS}</span>
        </span>
      </div>
      {(loading || error) && <PickerStatus error={error} />}
      {options.length === 0 && !loading && !error && <div className="px-3 py-2 text-xs text-zinc-500">No matches</div>}
      <ul id={id} role="listbox" aria-busy={loading || undefined} aria-label={heading} style={{ maxHeight: at.maxHeight - 56 }} className="scroll-thin overflow-y-auto overscroll-contain py-1">
        {options.map((t, i) => {
          const on = i === active
          return (
            <li
              key={t.token}
              id={`${id}-${i}`}
              role="option"
              aria-selected={on}
              aria-disabled={t.disabled ? true : undefined}
              data-token={t.token}
              title={t.disabled ? `Can't pick it now: ${t.disabled}` : kind === "project" ? `${t.label}: its Captain gets this message` : `${t.label} (${kind === "agent" ? "agent" : "runs_on"} ${t.value})`}
              onClick={() => pick(t)}
              onMouseMove={() => !t.disabled && !on && setActive(i)}
              className={cx(ROW, on && !t.disabled && "bg-zinc-800", t.disabled && "cursor-not-allowed opacity-50")}
            >
              <TargetRow t={t} on={on} trigger={TRIGGER[kind]} opens={opens(t)} />
            </li>
          )
        })}
      </ul>
    </div>,
    document.body,
  )
}

/** The sheet's search field, by level: an example at the top, the open level's name under it. */
function searchWords(kind: ListKind, parent: RunTarget | undefined): string {
  if (!parent) return kind === "agent" ? "Search, e.g. fable high" : "Search, e.g. box large"
  if (parent.under) return "Search efforts"
  return kind === "agent" ? `Search ${parent.label} models` : `Search ${parent.label}`
}

/** Found by a search, a model has no heading over it to say which kind it is: the row does, unless it's a latest one. */
const GROUP_TAG: Record<string, string> = { [MODEL_GROUP_LABEL.alias]: "alias", [MODEL_GROUP_LABEL.older]: "older" }

/**
 * One choice in the sheet: its name, then what sets it apart (a model's note or id, a place's specs, why it can't be
 * picked). `model` is the model of an effort the search found: the row is named for the model, with the effort beside it.
 */
function SheetRow({ t, on, opens, own, model, tagged }: { t: RunTarget; on: boolean; opens: boolean; own: boolean; model?: RunTarget; tagged: boolean }) {
  const Icon = iconOf(t)
  const tag = tagged && !own && t.group ? GROUP_TAG[t.group] : undefined
  const title = model ? (model.menuLabel ?? model.label) : (t.menuLabel ?? t.label)
  const second = t.disabled ?? (own || t.kind !== "harness" || !t.under ? t.detail : t.effort && !model ? null : (t.hint ?? (t.model && t.model !== title ? t.model : null)))
  return (
    <>
      <Icon className={cx("h-4 w-4 shrink-0", on ? "text-yard-400" : "text-zinc-500")} aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate">{title}</span>
          {model && <span className="shrink-0 rounded-md bg-yard-500/15 px-1.5 py-px text-xs text-yard-200">{t.menuLabel}</span>}
        </span>
        {second && <span className={cx("min-w-0 truncate text-xs", t.disabled ? "text-amber-300/80" : "text-zinc-500")}>{second}</span>}
      </span>
      {tag && <span className="shrink-0 text-xs text-zinc-500">{tag}</span>}
      {opens && <ChevronRight data-testid="run-target-opens" className="h-4 w-4 shrink-0 text-zinc-500" aria-label="More options" />}
    </>
  )
}

/**
 * The Where and Harness buttons' sheet: the typed list's choices and tokens behind a search field. Words find any
 * level at once ("fable high" is Claude Code's Fable at High effort); a row with more under it opens them.
 */
export function RunTargetPanel({ picks, returnFocus }: { picks: ChatPicksState; returnFocus: () => HTMLElement | null }) {
  const { list } = picks
  const { id, kind, parent, back, options, groups, active, loading, error, note, opens, pick, setActive, trail, panelQuery, setPanelQuery } = list
  const source = picks.lists[kind]
  const searching = Boolean(panelQuery.trim())
  const current = options[active]
  return (
    <PickerSheet
      testId="run-target-menu"
      kind={kind}
      trail={trail}
      onClose={picks.close}
      back={parent ? back : undefined}
      returnFocus={returnFocus}
      query={panelQuery}
      onQuery={setPanelQuery}
      placeholder={searchWords(kind, parent)}
      searchLabel={kind === "agent" ? "Search harnesses, models and efforts" : "Search where tasks run"}
      listId={id}
      options={options}
      active={active}
      setActive={setActive}
      keyOf={(t) => t.token}
      disabled={(t) => t.disabled}
      groupOf={(_, i) => groups[i]}
      onPick={pick}
      enterWord={(t) => (opens(t) ? "open" : undefined)}
      rowProps={(t) => ({ "data-token": t.token })}
      row={(t, on) => (
        <SheetRow t={t} on={on} opens={opens(t)} own={t.token === parent?.token} model={searching && t.effort ? source?.find((m) => m.token === t.under) : undefined} tagged={searching} />
      )}
      status={error ? <PickerStatus error /> : loading ? <Loading kind="rows" label="Checking availability" className="px-3 py-3" /> : undefined}
      empty={<>No matches for “{panelQuery.trim()}”.{kind === "agent" && !parent?.under && " Try a model and an effort: fable high."}</>}
      note={(searching || parent) && current ? <span className="font-mono" title="What picking it adds to the message">{TRIGGER[kind]}{current.token}</span> : note}
    />
  )
}

/**
 * The Where, Harness and (the Coordinator's) Project buttons for the composer's row of icons. Each shows its pick as an
 * icon (amber once the draft names one) and says it in its name; a press puts its trigger in the text and opens the
 * shared picker (useChatPicks `insert`). Where and Harness take focus into a sheet; Project keeps the text's list.
 * `className` sizes them like the row's other buttons.
 */
export function PickButtons({ picks, className }: { picks: ChatPicksState; className?: string }) {
  return (
    <>
      {picks.kinds.map((kind) => (
        <PickButton key={kind} kind={kind} picks={picks} className={className} />
      ))}
    </>
  )
}

/**
 * The same buttons as lines of the composer's More menu, for a box too narrow to show them on the row: each names its
 * pick and shows the character it types, so the menu teaches the shortcut too. `onDone` closes the menu after one.
 */
export function PickMenuItems({ picks, className, onDone }: { picks: ChatPicksState; className?: string; onDone: () => void }) {
  return (
    <>
      {picks.kinds.map((kind) => {
        const current = picks.picked[kind]
        return (
          <ComposerMenuItem
            key={kind}
            data-testid={`more-pick-${kind}`}
            icon={pickProblem(kind, picks) ? AlertTriangle : current ? iconOf(current) : DEFAULT_ICON[kind]}
            label={BUTTON_NAME[kind]}
            detail={pickWords(kind, picks)}
            keyHint={TRIGGER[kind]}
            className={className}
            onClick={() => {
              onDone()
              picks.insert(kind)
            }}
          />
        )
      })}
    </>
  )
}

/** What a button's pick is, in words: "@gpu (RunPod GPU)", "Default (Upstash box, box-yard's Runs on)", "none picked". */
export function pickWords(kind: ListKind, picks: Pick<ChatPicksState, "picked" | "defaults" | "projectId" | "projectName">) {
  const current = picks.picked[kind]
  if (current) return `${TRIGGER[kind]}${current.token} (${current.label}${current.disabled ? `, ${current.disabled}` : ""})`
  if (kind === "project") return "none picked, the Coordinator decides"
  const fallback = picks.defaults[kind]
  return `Default (${defaultWords(kind, picks)}${fallback?.disabled ? `: ${fallback.disabled}` : ""})`
}

/** Why the button's pick (or, with none, its Default) can't run where the tasks go; null when it can. */
function pickProblem(kind: ListKind, picks: Pick<ChatPicksState, "picked" | "defaults">): string | null {
  const current = picks.picked[kind]
  if (current) return current.disabled
  return kind === "project" ? null : (picks.defaults[kind]?.disabled ?? null)
}

export function PickButton({ kind, picks, className }: { kind: ListKind; picks: ChatPicksState; className?: string }) {
  const current = picks.picked[kind]
  const Icon = current ? iconOf(current) : DEFAULT_ICON[kind]
  const warn = Boolean(pickProblem(kind, picks))
  const trigger = TRIGGER[kind]
  const name = `${BUTTON_NAME[kind]}: ${pickWords(kind, picks)}`
  return (
    <button
      type="button"
      data-testid={`pick-${kind}`}
      aria-label={name}
      aria-haspopup={kind === "project" ? "listbox" : "dialog"}
      aria-expanded={picks.open && picks.list.kind === kind}
      title={`${name}. Adds ${trigger} to the message: pick from its list, or type ${trigger} yourself`}
      // Preserve the caret until insert has placed or selected the token.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => picks.insert(kind)}
      className={cx(
        "flex shrink-0 items-center justify-center rounded-lg focus-visible:ring-2 focus-visible:ring-yard-500/60 focus-visible:outline-none",
        className,
        warn ? "bg-amber-500/10 text-amber-300 hover:bg-amber-500/20" : current ? "bg-yard-500/10 text-yard-200 hover:bg-yard-500/20" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200",
      )}
    >
      {warn ? <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden /> : <Icon className="h-4 w-4 shrink-0" aria-hidden />}
    </button>
  )
}

function PickerStatus({ error }: { error: boolean }) {
  return <div role="status" className="px-3 py-2 text-xs text-zinc-500">{error ? "Couldn't refresh availability. Try opening again." : "Checking availability…"}</div>
}

/**
 * What Default is, in words: "This computer, Mobile's Runs on" in a Captain's chat, "each project's agent" in the
 * Coordinator's (it picks each task's project), "the project's Runs on" until the project loads.
 */
function defaultWords(kind: PickKind, picks: Pick<ChatPicksState, "defaults" | "projectId" | "projectName">, sep = ", ") {
  const t = picks.defaults[kind]
  if (!picks.projectId) return `each project's ${SETTING[kind]}`
  if (!t || !picks.projectName) return `the project's ${SETTING[kind]}`
  return `${t.label}${sep}${picks.projectName}'s ${SETTING[kind]}`
}

/** Over the buttons when the picks can't go together (Codex on an SSH machine): say so before it's sent. */
export function PickConflict({ text }: { text: string }) {
  return (
    <div role="status" data-testid="pick-conflict" className="flex items-start gap-1.5 px-1.5 pt-1 text-xs text-amber-300">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="min-w-0">{text}</span>
    </div>
  )
}

/** What an inline pick's chip says it's for: its item, or why it isn't the whole message's. */
const INLINE_SHORT: Record<InlineReason, string> = { item: "", mixed: "disagrees", words: "words differ" }
const INLINE_WHY: Record<InlineReason, string> = {
  item: "",
  mixed: "another pick of its kind in the message disagrees",
  words: "the message's words ask for another harness",
}
/** What a whole-message pick does, for its chip's title. */
const WIDE_EFFECT: Record<ListKind, string> = {
  runsOn: "Box Yard applies it to every task it leads to",
  agent: "Box Yard applies it to every task it leads to",
  project: "the Coordinator sends all of it to that project's Captain",
}
const inlineTitle = (p: { kind: ListKind; token: string; reason: InlineReason }, where: string | null, sent: boolean) =>
  `${TRIGGER[p.kind]}${p.token} is only for ${where ? where : `part of the message (${INLINE_WHY[p.reason]})`}: Box Yard doesn't apply it to the whole message. ` +
  `The ${sent ? "Coordinator or Captain was" : "Coordinator or Captain is"} told where it is, to pass it on that task.`

/**
 * Over the composer's buttons when the draft has picks for only part of it (an "@" or "!" inside one item of a list
 * of tasks, or ones that disagree): which are for the whole message and which are only hints for their part, as
 * scopePicks sees them. A draft with only whole-message picks shows nothing here: the buttons say those.
 */
export function PickScope({ scoped }: { scoped: ScopedPick[] }) {
  const inline = scoped.filter((p) => p.scope === "inline")
  if (!inline.length) return null
  // The whole message's, once each (an item may name it again).
  const wide = scoped.filter((p, i) => p.scope === "message" && scoped.findIndex((q) => q.scope === "message" && q.kind === p.kind) === i)
  return (
    <div data-testid="pick-scope" className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1.5 pt-1 text-[11px] text-zinc-500">
      {wide.length > 0 && (
        <span className="flex min-w-0 flex-wrap items-center gap-1">
          <span className="shrink-0">Whole message</span>
          {wide.map((p) => (
            <ScopeChip key={`${p.kind}-${p.start}`} testId="pick-scope-wide" t={p.target} kind={p.kind} title={`${TRIGGER[p.kind]}${p.target.token} is for the whole message: ${WIDE_EFFECT[p.kind]}.`} />
          ))}
        </span>
      )}
      <span className="flex min-w-0 flex-wrap items-center gap-1">
        <span className="shrink-0">Only their part</span>
        {inline.map((p) => (
          <ScopeChip
            key={`${p.kind}-${p.start}`}
            testId="pick-scope-inline"
            t={p.target}
            kind={p.kind}
            inline
            where={p.item?.label ?? INLINE_SHORT[p.reason!]}
            title={inlineTitle({ kind: p.kind, token: p.target.token, reason: p.reason! }, p.item?.label ?? null, false)}
          />
        ))}
      </span>
    </div>
  )
}

/** One pick on the scope line: solid for the whole message's, dashed for one that's only its part's ("item 9"). */
function ScopeChip({ t, kind, inline = false, where, title, testId }: { t: Pick<RunTarget, "kind" | "token">; kind: ListKind; inline?: boolean; where?: string; title: string; testId: string }) {
  const Icon = iconOf(t)
  return (
    <span
      data-testid={testId}
      title={title}
      className={cx(
        "inline-flex max-w-full min-w-0 items-center gap-1 rounded-full border px-2 py-0.5",
        inline ? "border-dashed border-zinc-600 text-zinc-300" : "border-yard-500/30 bg-yard-500/10 text-yard-200",
      )}
    >
      <Icon className="h-3 w-3 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">
        <span className="font-mono">
          {TRIGGER[kind]}
          {t.token}
        </span>
        {where ? ` · ${where}` : ""}
      </span>
    </span>
  )
}

/**
 * Under a sent message with picks (meta.runsOn, meta.agent, meta.project): its project, where its tasks run and on
 * which harness; then, dashed, the picks that were only for part of it (meta.inlinePicks) with where each was.
 */
export const PickChips = memo(function PickChips({ meta }: { meta: Record<string, unknown> | null | undefined }) {
  const where = runTargetPickOf(meta, "runsOn")
  const agent = runTargetPickOf(meta, "agent")
  const project = runTargetPickOf(meta, "project")
  const inline = inlinePicksOf(meta)
  if (!where && !agent && !project && !inline.length) return null
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {project && (
        <Chip testId="project-pick-chip" icon={FolderGit2} title={`Picked with %: this message is for ${project.label}, so its Captain gets it`}>
          <span className="font-mono">%{project.token}</span>
          {project.label.toLowerCase() !== project.token ? ` · ${project.label}` : ""}
        </Chip>
      )}
      {where && (
        <Chip
          testId="runs-on-chip"
          icon={iconOf({ kind: where.value.startsWith("label:") ? (where.token.startsWith("label:") ? "label" : "machine") : "runner", token: where.token })}
          title={`Picked with @: this message's tasks run on ${where.label} (runs_on ${where.value})`}
        >
          Runs on <span className="font-mono">@{where.token}</span>
          {where.label.toLowerCase() !== where.token ? ` · ${where.label}` : ""}
        </Chip>
      )}
      {agent && (
        <Chip testId="agent-pick-chip" icon={iconOf({ kind: "harness", token: agent.token })} title={`Picked with !: this message's tasks run on ${agent.label} (agent ${agent.value})`}>
          <span className="font-mono">!{agent.token}</span> · {agent.label}
        </Chip>
      )}
      {inline.map((p, i) => (
        <ScopeChip
          key={`${p.kind}-${i}`}
          testId="inline-pick-chip"
          t={{ kind: p.kind === "agent" ? "harness" : p.kind === "project" ? "project" : p.value.startsWith("label:") ? "label" : "runner", token: p.token }}
          kind={p.kind}
          inline
          where={p.where ? itemLabel(p.where) : INLINE_SHORT[p.reason]}
          title={inlineTitle(p, p.where, true)}
        />
      ))}
    </div>
  )
})

/** "item 9" from a sent pick's where (`item 9 ("Port the pickaxe…")`), for its chip; the title has the rest. */
const itemLabel = (where: string) => /^(?:item|bullet) \d+/.exec(where)?.[0] ?? where

function Chip({ testId, icon: Icon, title, children }: { testId: string; icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <span
      data-testid={testId}
      title={title}
      className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-full border border-yard-500/30 bg-yard-500/10 px-2 py-0.5 text-[11px] text-yard-200"
    >
      <Icon className="h-3 w-3 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{children}</span>
    </span>
  )
}
