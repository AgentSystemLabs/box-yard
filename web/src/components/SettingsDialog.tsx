import { useEffect, useId, useMemo, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react"
import { flushSync } from "react-dom"
import { ArrowLeft, Palette, BarChart3, Bell, Bot, Boxes, Check, CircleAlert, Cloud, Container, Laptop, Cpu, DollarSign, Fingerprint, FolderGit2, Info, KeyRound, Network, Plug, Server, Search, X, Volume2, Webhook, type LucideIcon } from "lucide-react"
import { useAgentSettings, useHealth, useModels, useResetSettings, useSaveSettings, useSettings } from "../lib/queries"
import {
  SETTINGS_SECTIONS,
  SETTINGS_TOP_SECTIONS,
  settingsRoot,
  SETTING_ENV,
  changedKeys,
  changedSections,
  savePatch,
  type SettingsSection,
} from "../lib/settingsNav"
import { SettingsDraftContext, SettingsFieldError, draftSlots, updateParts, useDraft, type DraftPart, type DraftRegistry } from "../lib/settingsDraft"
import { SettingsField, SettingsSearchProvider, SearchHighlight, useSettingsSearch } from "../lib/settingsSearch"
import { NUMBER_RULES, numberText, problemSections, refusedByBrowser, settingsProblems, typedNumber, type SettingPath } from "../lib/settingsValidation"
import { LEGACY_POOL_DEFAULTS, sizeCapacities } from "../lib/capacity"
import { AppearancePanel } from "./AppearanceSettings"
import { VoicePanel } from "./VoiceSettings"
import { SendSoundRow } from "./SendSoundSettings"
import { BrowserNotificationsRow } from "./BrowserNotificationSettings"
import { setSendSound, useSendSound } from "../lib/sendSound"
import { HooksPanel } from "./Hooks"
import { CredentialsPanel, LocalRunnerPanel, UpstashPanel } from "./Setup"
import { RunnerSettings } from "./RunnerSettings"
import { IdentitiesPanel } from "./Identities"
import { ConnectorsPanel } from "./Connectors"
import { RunPodPanel } from "./RunPodSettings"
import { VastPanel } from "./VastSettings"
import { DaytonaPanel } from "./DaytonaSettings"
import { DockerPanel } from "./DockerSettings"
import { MachinesPanel } from "./MachineSettings"
import { useOpenUsage } from "./UsageHost"
import { ProjectSettingsPicker } from "./ProjectSettingsDialog"
import { Modal } from "./Modal"
import { Panel, Row, SAVE_IDLE, SettingsLink, SourceHint } from "./SettingsBlocks"
import { UpstashSizes } from "./SizeCards"
import { SettingsTabs, type SettingsTab } from "./SettingsTabs"
import { confirmDialog } from "../lib/confirm"
import { isTouchDevice } from "../lib/composer"
import { DEFAULT_OWNER_NAME } from "../../../shared/owner"
import { EffortPicker, ModelPicker } from "./ModelPicker"
import { CaptainIconPicker } from "./CaptainIconPicker"
import { EFFORT_LABEL, findModel } from "../../../shared/models"
import { CodexModelSelect } from "./CodexModelSelect"
import { OpenCodeModelInput } from "./OpenCodeModelInput"
import { CursorModelSelect } from "./CursorModelSelect"
import { Button, LineIcon, NewTabLink, Select, TAP_AREA, cx, inputClass } from "./ui"
import { Loading } from "./Loading"
import { UpdateRow } from "./UpdateBanner"
import { BOX_SIZE_SPECS } from "../../../shared/boxSizes"
import { AGENT_CLIS, AGENT_CLI_LABEL, hasSeparateEffort, MANAGER_CLIS, type AgentCli } from "../../../shared/agentCli"
import { NOTE_BUDGET_LIMITS } from "../../../shared/notes"
import { PR_COMMENT_MINUTES, prCommentMinutesLabel } from "../../../shared/prComments"
import { LOCAL_AGENTS_LIMITS, LOCAL_UNSANDBOXED } from "../../../shared/runner"
import {
  AUTOCOMPACT_MAX_TOKENS,
  AUTOCOMPACT_MIN_TOKENS,
  BOX_CREATE_CONCURRENCY,
  BOX_SIZES,
  SUBTASK_MAX_CHILDREN,
  SUBTASK_MAX_DEPTH,
  DEFAULT_AUTOCOMPACT_TOKENS,
  SIZE_DEFAULTS,
  UPSTASH_FREE_CONCURRENT_BOXES,
  WORKER_SIZES,
  agentCapacity,
  type AgentEffort,
  type AutoCompact,
  type BoxSize,
  type Settings,
  type SettingSource,
} from "../../../shared/types"


const SECTION_ICON: Record<SettingsSection, LucideIcon> = { orchestrator: Network, projects: FolderGit2, agents: Bot, runners: Server, local: Laptop, upstash: Cloud, credentials: KeyRound, identities: Fingerprint, connectors: Plug, runpod: Cpu, vast: Cpu, daytona: Cpu, docker: Container, machines: Server, hooks: Webhook, limits: Boxes, costs: DollarSign, notifications: Bell, voice: Volume2, appearance: Palette, about: Info }
const TOP_TABS: SettingsTab<SettingsSection>[] = SETTINGS_TOP_SECTIONS.map((s) => ({ key: s.key, label: s.label, icon: SECTION_ICON[s.key] }))
/** Categories with nothing to save: a list, or facts. With no change pending anywhere, their footer is just Close. */
const NO_DRAFT_SECTIONS: SettingsSection[] = ["projects", "about"]

// ------------------------------------------------------------------ building blocks

/** A field's problem, under its control, which points at it with aria-describedby. Search doesn't index it. */
function FieldError({ id, children }: { id: string; children: ReactNode }) {
  const ref = useRef<HTMLParagraphElement>(null)
  // It can appear under the fold, below a field at the bottom of the panel: the panel scrolls just enough to show it.
  useEffect(() => ref.current?.scrollIntoView?.({ block: "nearest" }), [])
  return (
    <p ref={ref} id={id} data-settings-search-ignore className="flex basis-full items-start gap-1.5 text-xs leading-relaxed text-red-300">
      <LineIcon icon={CircleAlert} className="h-3.5 w-3.5" />
      <span className="min-w-0">{children}</span>
    </p>
  )
}

/** On a field's control: Save finds a problem by `data-setting`, and the control names its error. */
type FieldProps = InputHTMLAttributes<HTMLInputElement> & { "data-setting": SettingPath }
type FieldCheck = (path: SettingPath) => FieldProps
/** A Row's `hint` and `changed` for a setting: its problems and where its value comes from, and "unsaved" beside its label. */
type RowMeta = (k: keyof Settings, problems?: SettingPath[]) => { hint: ReactNode; changed: boolean }
type NumberKey = { [K in keyof Settings]-?: Settings[K] extends number ? K : never }[keyof Settings]

function AutoCompactControl({
  id,
  label,
  value,
  onChange,
  tokens = 800_000,
  field,
}: {
  id: string
  label: string
  value: AutoCompact
  onChange: (v: AutoCompact) => void
  /** The token count a switch to "tokens" starts from. */
  tokens?: number
  field?: FieldProps
}) {
  const percent = value.unit === "percent"
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-sm text-zinc-300">
        <input id={id} type="checkbox" checked={value.enabled} onChange={(e) => onChange({ ...value, enabled: e.target.checked })} />
        <SearchHighlight text={value.enabled ? "On: compacts past the threshold below" : "Off: only the CLI's own compaction"} />
      </label>
      <div className="flex flex-col gap-2 @sm:flex-row @sm:items-center">
        <input
          type="number"
          className={cx(inputClass, "min-w-0 flex-1 disabled:opacity-50")}
          disabled={!value.enabled}
          value={numberText(value.value)}
          min={percent ? 10 : AUTOCOMPACT_MIN_TOKENS}
          max={percent ? 95 : AUTOCOMPACT_MAX_TOKENS}
          step={percent ? 5 : 10_000}
          onChange={(e) => onChange({ ...value, value: typedNumber(e.target.value) })}
          aria-label={`${label} threshold`}
          {...field}
        />
        <Select
          className="w-full shrink-0 @sm:w-36"
          disabled={!value.enabled}
          value={value.unit}
          aria-label={`${label} unit`}
          onChange={(e) => {
            const unit = e.target.value as AutoCompact["unit"]
            onChange({ ...value, unit, value: unit === "percent" ? 80 : tokens })
          }}
        >
          <option value="percent">% of window</option>
          <option value="tokens">tokens</option>
        </Select>
      </div>
    </div>
  )
}

/** One of `clis` (shared/agentCli.ts): every harness for task agents, Claude Code or Codex for the Coordinator and Captains. */
function AgentCliSelect<C extends AgentCli>({ id, value, onChange, testId, clis }: { id: string; value: C; onChange: (v: C) => void; testId: string; clis: readonly C[] }) {
  return (
    <Select id={id} className="w-full" value={value} onChange={(e) => onChange(e.target.value as C)} data-testid={testId}>
      {clis.map((c) => (
        <option key={c} value={c}>
          {AGENT_CLI_LABEL[c]}
        </option>
      ))}
    </Select>
  )
}

// ------------------------------------------------------------------ dialog

export function SettingsDialog({
  section,
  onSection,
  onClose,
}: {
  section: SettingsSection
  onSection: (s: SettingsSection) => void
  onClose: () => void
}) {
  const info = useAgentSettings()
  const save = useSaveSettings()
  const reset = useResetSettings()
  const resetFields = useResetSettings()
  const [draft, setDraft] = useState<Settings | null>(null)
  // Box limits typed in while the size defaults apply: saved even when the number matches the default.
  const [pinned, setPinned] = useState<(keyof Settings)[]>([])
  // Saved values to forget on Save ("Use size default").
  const [resets, setResets] = useState<(keyof Settings)[]>([])
  // Drafts of the parts that aren't plain Settings fields (voice, keys, RunPod, hooks...), registered by useDraft.
  const [parts, setParts] = useState<Record<string, DraftPart>>({})
  const registry = useMemo<DraftRegistry>(() => ({ update: (id, part) => setParts((p) => updateParts(p, id, part)), slot: draftSlots() }), [])
  // Sections opened so far stay mounted (hidden), so their drafts survive switching sections.
  const [visited, setVisited] = useState<SettingsSection[]>([section])
  const [query, setQuery] = useState("")
  const searchRef = useRef<HTMLInputElement>(null)
  // Where the tabs fold into a dropdown (a phone), search folds into a button beside it: pressing it swaps the field in.
  const [searchOpen, setSearchOpen] = useState(false)
  const searchToggle = useRef<HTMLButtonElement>(null)
  // After a clear or Esc, focus goes to whichever of the two is on screen: `first` is tried first.
  const [refocus, setRefocus] = useState<{ first: "toggle" | "field" | "panel" } | null>(null)
  const models = useModels()
  const modelName = (id: string) => findModel(models, id)?.label ?? id
  const { registry: searchRegistry, matches, searching } = useSettingsSearch(query, (target) => leaveSearchFor(target))
  const searchCategories = new Set(matches.map((f) => f.category))
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState(0)
  const ids = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const previousSection = useRef(section)

  const current = info.data
  const s = draft ?? current?.settings
  const changed = [...new Set([...(draft ? [...changedKeys(draft, current?.settings), ...pinned] : []), ...resets])]
  const partList = Object.values(parts)
  const changeCount = changed.length + partList.reduce((n, p) => n + p.count, 0)
  const dirty = changeCount > 0
  const dirtySections = new Set([...changedSections(changed), ...partList.map((p) => p.section)])
  const rootSection = settingsRoot(section)
  const rootDirty = (key: SettingsSection) => [...dirtySections].some((s) => settingsRoot(s) === key)
  // What Save would send, checked with the server's limits: each problem shows under its field and holds Save.
  const patch = draft ? savePatch(draft, current?.settings, pinned) : {}
  for (const k of resets) delete patch[k]
  const problems = settingsProblems(patch)
  const problemCount = Object.keys(problems).length
  const problemRoots = new Set([...problemSections(problems)].map(settingsRoot))
  // A field to show after Save found a problem: its section opens first, then it's focused.
  const [reveal, setReveal] = useState<HTMLElement | string | null>(null)

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    if (!s) return
    setDraft({ ...s, [k]: v })
    setResets((r) => (r.includes(k) ? r.filter((x) => x !== k) : r))
  }
  const pin = (k: keyof Settings, on: boolean) => setPinned((p) => (on ? (p.includes(k) ? p : [...p, k]) : p.filter((x) => x !== k)))
  // Forget just these saved values on Save; until then the field shows the size defaults, marked unsaved.
  const resetKeys = (keys: (keyof Settings)[]) => {
    setResets((r) => [...new Set([...r, ...keys])])
    setPinned((p) => p.filter((k) => !keys.includes(k)))
    setDraft((d) => d && { ...d, ...Object.fromEntries(keys.map((k) => [k, current?.settings[k]])) })
  }
  const fid = (k: string) => `${ids}-${k}`
  const errorId = (path: SettingPath) => fid(`error-${path}`)
  const field: FieldCheck = (path) => ({ "data-setting": path, ...(problems[path] && { "aria-invalid": true, "aria-describedby": errorId(path) }) })
  // Under the control: the field's problems (by default its key's), then where its value comes from. "unsaved" goes beside the label.
  const row: RowMeta = (k, paths = [k]) => ({
    changed: changed.includes(k),
    hint: (
      <>
        {paths.map((p) => problems[p] && <FieldError key={p} id={errorId(p)}>{problems[p]}</FieldError>)}
        <SourceHint source={current?.sources[k]} env={SETTING_ENV[k]} changed={false} />
      </>
    ),
  })

  const discard = () => {
    setDraft(null)
    setPinned([])
    setResets([])
    setSaveError(null)
    for (const p of partList) p.discard()
  }

  const mayDiscard = () =>
    confirmDialog({
      title: "Discard unsaved changes?",
      body: `${changeCount === 1 ? "1 change" : `${changeCount} changes`} to settings haven't been saved.`,
      confirmLabel: "Discard",
      cancelLabel: "Keep editing",
      danger: true,
    })

  const close = async () => {
    if (dirty && !(await mayDiscard())) return
    onClose()
  }

  // One change is as quick to make again as to confirm; more than one asks first, as closing does.
  const discardAsked = async () => {
    if (changeCount > 1 && !(await mayDiscard())) return
    discard()
  }

  useEffect(() => {
    setVisited((v) => (v.includes(section) ? v : [...v, section]))
  }, [section])

  // Search takes focus on open, except under a finger: there it would raise the keyboard over the settings, so the
  // panel takes it instead (Modal's own pick is the header's ×).
  useEffect(() => {
    if (!isTouchDevice()) searchRef.current?.focus()
    // Also where search is folded away (a narrow window): its field can't take focus there.
    if (document.activeElement !== searchRef.current) panelRef.current?.focus({ preventScroll: true })
  }, [])

  /** Focuses search, opening it first where it's folded into its button. */
  const focusSearch = () => {
    searchRef.current?.focus()
    if (document.activeElement !== searchRef.current) {
      flushSync(() => setSearchOpen(true))
      searchRef.current?.focus()
    }
    searchRef.current?.select()
  }
  const closeSearch = () => {
    setQuery("")
    setRefocus({ first: searchOpen ? "toggle" : "field" })
    setSearchOpen(false)
  }
  useEffect(() => {
    if (!refocus) return
    if (refocus.first === "panel") return panelRef.current?.focus({ preventScroll: true })
    const order = refocus.first === "toggle" ? [searchToggle.current, searchRef.current] : [searchRef.current, searchToggle.current]
    for (const el of order) {
      el?.focus()
      if (document.activeElement === el) break
    }
  }, [refocus])

  /** A search result's category header: search ends and that category opens, with focus on its panel (the header is gone). */
  const leaveSearchFor = (target: SettingsSection) => {
    setQuery("")
    setSearchOpen(false)
    if (target !== section) onSection(target)
    setRefocus({ first: "panel" })
  }

  // Another category (a tab, a link in a help text or a search result) leaves search.
  useEffect(() => {
    setQuery("")
    setSearchOpen(false)
  }, [section])

  // A provider drill-in hides its button. Keep keyboard focus in the visible level, and return it on Back.
  useEffect(() => {
    const previous = previousSection.current
    previousSection.current = section
    if (previous === section) return
    if (settingsRoot(section) !== section) panelRef.current?.querySelector<HTMLButtonElement>("[data-settings-back]")?.focus()
    else if (settingsRoot(previous) === section) panelRef.current?.querySelector<HTMLButtonElement>(`[data-runner-section=${previous}]`)?.focus()
    // A link in a dialog that closed to show this category (a project's settings): its focus has nowhere to go back to.
    else if (document.activeElement === document.body) panelRef.current?.focus({ preventScroll: true })
  }, [section])

  // Document runs before the window palette/Modal handlers. Nested dialogs keep their own keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const dialog = searchRef.current?.closest("[role=dialog]")
      const dialogs = document.querySelectorAll("[role=dialog]")
      if (!dialog || dialogs.item(dialogs.length - 1) !== dialog || e.defaultPrevented || e.isComposing) return
      const target = e.target as HTMLElement
      const typing = target.closest?.("input, textarea, [contenteditable=true]")
      if ((e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f")) {
        e.preventDefault()
        focusSearch()
      } else if (e.key === "Escape" && query) {
        e.preventDefault()
        e.stopPropagation()
        setQuery("")
        setRefocus({ first: "field" })
      } else if (e.key === "Escape" && searchOpen) {
        e.preventDefault()
        e.stopPropagation()
        closeSearch()
      }
    }
    document.addEventListener("keydown", onKey, true)
    return () => document.removeEventListener("keydown", onKey, true)
  }, [query, searchOpen])

  useEffect(() => {
    panelRef.current?.scrollTo({ top: 0 })
  }, [section, query])

  // After the scroll reset above. Waits while its section is still hidden (it shows on the next render).
  useEffect(() => {
    const control = typeof reveal === "string" ? document.getElementById(reveal) : reveal
    if (!control || control.closest("[hidden]")) return
    const details = control.closest("details")
    if (details) details.open = true
    control.scrollIntoView({ block: "center" })
    control.focus({ preventScroll: true })
    // A value only the browser checks gets the browser's own message.
    if (!control.hasAttribute("data-setting") && !control.hasAttribute("data-identity-field")) (control as HTMLInputElement).reportValidity?.()
    setReveal(null)
  }, [reveal, section, query])

  // Drafts live only in this dialog: reloading or closing the tab asks first, as closing the dialog does.
  useEffect(() => {
    if (!dirty) return
    const onLeave = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = "" // Older Safari and Firefox
    }
    window.addEventListener("beforeunload", onLeave)
    return () => window.removeEventListener("beforeunload", onLeave)
  }, [dirty])

  useEffect(() => {
    if (!savedAt) return
    const t = setTimeout(() => setSavedAt(0), 2500)
    return () => clearTimeout(t)
  }, [savedAt])

  const saveCore = async () => {
    if (draft && (changedKeys(draft, current?.settings).length || pinned.length)) {
      const patch = savePatch(draft, current?.settings, pinned)
      for (const k of resets) delete patch[k]
      await save.mutateAsync(patch)
    }
    if (resets.length) await resetFields.mutateAsync(resets)
    setDraft(null)
    setPinned([])
    setResets([])
  }

  /** Opens `el`'s section (and leaves search) so the reveal effect can focus it. */
  const showField = (el: HTMLElement) => {
    const where = el.closest<HTMLElement>("[data-settings-section]")?.dataset.settingsSection as SettingsSection | undefined
    setQuery("")
    if (where && where !== section) onSection(where)
    setReveal(el)
  }

  /** The first field to fix: this section's, else the first section's with one. */
  const firstProblem = (form: HTMLFormElement) => {
    const invalid = "[data-setting][aria-invalid=true]"
    const own = form.querySelector<HTMLElement>(`[data-settings-section=${section}] ${invalid}`) ?? form.querySelector<HTMLElement>(invalid)
    // Other panels' fields have only the browser's checks (Save skips its own, which ignore hidden sections).
    return own ?? [...form.elements].find((el): el is HTMLInputElement => el instanceof HTMLInputElement && el.willValidate && refusedByBrowser(el.validity)) ?? null
  }

  /** Shows the first field to fix, if there is one: Save does, and the footer's "Fix 1 field to save". */
  const showProblem = (form: HTMLFormElement) => {
    const problem = firstProblem(form)
    if (problem) showField(problem)
    // A problem with no control on screen (its field is switched off): at least open its section.
    else if (problemCount) onSection(SETTINGS_SECTIONS.find((sec) => problemRoots.has(sec.key))?.key ?? section)
    return Boolean(problem) || problemCount > 0
  }

  const resetAll = async () => {
    if (!(await confirmDialog({ title: "Reset settings to defaults?", body: "Forget every value saved here? Env vars and defaults apply again.", confirmLabel: "Reset", danger: true }))) return
    reset.mutate(undefined, {
      onSuccess: () => {
        setDraft(null)
        setPinned([])
        setResets([])
      },
    })
  }

  const failedSave = (error: unknown) => {
    setSaveError(error instanceof Error ? error.message : "Couldn't save")
    if (error instanceof SettingsFieldError) {
      error.reveal?.()
      setQuery("")
      onSection(error.section)
      setReveal(error.controlId)
    }
  }

  // One Save writes every draft. Each part starts inside the click, so a browser permission prompt still works.
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!dirty || saving) return
    setSaveError(null)
    // Validate every pending part before writing anything, even when its editor or section is hidden.
    try {
      for (const part of partList) part.validate?.()
    } catch (error) {
      failedSave(error)
      return
    }
    if (showProblem(e.currentTarget as HTMLFormElement)) return
    setSaving(true)
    setSaveError(null)
    const jobs = [...(changed.length ? [saveCore()] : []), ...partList.map((p) => p.save())]
    const failed = (await Promise.allSettled(jobs)).filter((r): r is PromiseRejectedResult => r.status === "rejected")
    setSaving(false)
    if (failed.length) failedSave(failed[0]!.reason)
    else setSavedAt(Date.now())
  }

  return (
    <Modal
      size="xl"
      title="Settings"
      description="Nothing changes until you Save."
      dirty={dirty}
      onClose={() => void close()}
      onSubmit={submit}
      className="settings-dialog @container/settings sm:h-[min(88dvh,56rem)]"
      bodyClassName="settings-body @container flex min-h-0 flex-1 flex-col"
      footer={
        <>
          {saveError && (
            <span className="text-xs text-red-300 wrap-anywhere" role="alert">
              Couldn't save: {saveError}
            </span>
          )}
          {/* One row at any width: what Save would do on the left, always there so the buttons never move. */}
          <div className="min-w-0 text-xs @2xl/settings:text-right">
            {saveError ? null : problemCount && dirty ? (
              <span role="status" data-testid="settings-problems">
                <button
                  type="button"
                  className={cx(TAP_AREA, "rounded text-left text-red-300 underline underline-offset-2 hover:text-red-200")}
                  title="Show the first field to fix"
                  onClick={(e) => e.currentTarget.form && showProblem(e.currentTarget.form)}
                >
                  {problemCount === 1 ? "Fix 1 field to save" : `Fix ${problemCount} fields to save`}
                </button>
              </span>
            ) : dirty ? (
              <span className="text-amber-300" role="status" data-testid="unsaved-count">
                {changeCount === 1 ? "1 unsaved change" : `${changeCount} unsaved changes`}
              </span>
            ) : savedAt ? (
              <span className="inline-flex items-center gap-1 text-emerald-400" role="status">
                <Check className="h-3.5 w-3.5" /> Saved
              </span>
            ) : null}
          </div>
          {dirty ? (
            <Button type="button" variant="ghost" onClick={() => void discardAsked()}>
              Discard
            </Button>
          ) : (
            <Button type="button" variant="ghost" onClick={onClose}>
              Close
            </Button>
          )}
          {/* Save checks every field itself: the browser's check can't reach a hidden section and refuses numbers between steps. */}
          {(dirty || searching || !NO_DRAFT_SECTIONS.includes(section)) && (
            <Button type="submit" variant="primary" loading={saving} disabled={!dirty} className={dirty ? undefined : SAVE_IDLE} formNoValidate>
              Save
            </Button>
          )}
        </>
      }
    >
      <SettingsSearchProvider value={searchRegistry}>
      {/* Where the tabs fold into a dropdown (SettingsTabs), search is a button beside it until pressed, then takes its place (at the dropdown's height, so nothing under it moves). */}
      <div className={cx("shrink-0 border-b border-zinc-900 p-3", !(searchOpen || query) && "@max-3xl:hidden")}>
        {/* One focus ring, the box's (as the composer's): the field inside draws none of its own. */}
        <div data-control-boundary className="flex min-h-11 items-center gap-2 rounded-lg border border-control bg-zinc-900 px-3 @max-3xl:h-11 has-[>input:focus-visible]:border-yard-500 has-[>input:focus-visible]:outline-2 has-[>input:focus-visible]:outline-offset-2 has-[>input:focus-visible]:outline-(color:--focus-ink)">
          <Search aria-hidden="true" className="h-4 w-4 shrink-0 text-zinc-500" />
          <input
            ref={searchRef} type="search" aria-label="Search settings" placeholder="Search settings…" value={query}
            className="min-h-11 min-w-0 flex-1 bg-transparent text-base text-zinc-100 outline-none! [&::-webkit-search-cancel-button]:appearance-none"
            onChange={(e) => {
              setQuery(e.target.value)
              if (e.target.value.trim()) setVisited(SETTINGS_SECTIONS.map((s) => s.key))
            }}
            onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault() }}
            // Left empty, it folds back into its button (where it folds at all).
            onBlur={(e) => {
              if (e.target.value.trim() || e.currentTarget.parentElement?.contains(e.relatedTarget as Node | null)) return
              setQuery("")
              setSearchOpen(false)
            }}
          />
          {(query || searchOpen) && <button type="button" aria-label={query ? "Clear settings search" : "Close settings search"} className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-zinc-400" onClick={closeSearch}><X className="h-4 w-4" /></button>}
        </div>
        {searching && <p role="status" className="mt-2 text-xs text-zinc-400">{matches.length} matching {matches.length === 1 ? "field" : "fields"} in {searchCategories.size} {searchCategories.size === 1 ? "category" : "categories"}</p>}
      </div>
      <SettingsTabs
        tabs={TOP_TABS}
        selected={rootSection}
        onSelect={onSection}
        mark={(key) => (problemRoots.has(key) ? "problem" : rootDirty(key) ? "unsaved" : null)}
        label="Settings categories"
        selectLabel="Settings category"
        idPrefix={ids}
        navHidden={searching}
        selectHidden={searchOpen || Boolean(query)}
        selectTrailing={
          <button
            ref={searchToggle}
            type="button"
            aria-label="Search settings"
            aria-expanded={searchOpen}
            title="Search settings"
            onClick={focusSearch}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-control bg-zinc-900 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
          >
            <Search aria-hidden="true" className="h-4 w-4" />
          </button>
        }
        className={searching ? "settings-searching" : undefined}
        panelRef={panelRef}
        panelRole={searching ? "region" : "tabpanel"}
        panelLabel={searching ? "Settings search results" : SETTINGS_SECTIONS.find((s) => s.key === section)!.label}
      >
        {!searching && rootSection !== section && <button type="button" data-settings-back onClick={() => onSection(rootSection)} className="mb-4 flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm text-yard-300"><ArrowLeft aria-hidden="true" className="h-4 w-4" />Box providers</button>}
        {searching && matches.length === 0 && <div className="py-10 text-center"><p className="text-sm text-zinc-200">No settings found</p><p className="mt-2 text-xs text-zinc-500">Try a different word, like model, signing or voice.</p></div>}
        <SettingsDraftContext.Provider value={registry}>
          {SETTINGS_SECTIONS.filter((sec) => visited.includes(sec.key)).map(({ key: category }) => (
            <div key={category} hidden={!searching && category !== section} data-settings-section={category}>
              {category === "notifications" ? (
                <NotificationsPanel fid={fid} />
              ) : category === "voice" ? (
                <VoicePanel fid={fid} />
              ) : category === "runners" ? (
                <RunnerSettings fid={fid} onSection={onSection} dirtySections={dirtySections} active={!searching && rootSection === "runners"} settings={s ? { s, set, row } : null} />
              ) : category === "local" ? (
                <LocalRunnerPanel fid={fid} />
              ) : category === "upstash" ? (
                <UpstashPanel fid={fid}>
                  {s ? (
                    <UpstashBoxRows s={s} set={set} row={row} field={field} fid={fid} sources={current?.sources} changed={changed} current={current?.settings} pin={pin} resetKeys={resetKeys} resets={resets} />
                  ) : (
                    <Loading label="Loading box sizes" />
                  )}
                </UpstashPanel>
              ) : category === "credentials" ? (
                <CredentialsPanel fid={fid} />
              ) : category === "identities" ? (
                <IdentitiesPanel fid={fid} />
              ) : category === "connectors" ? (
                <ConnectorsPanel fid={fid} />
              ) : category === "runpod" ? (
                <RunPodPanel fid={fid} active={section === "runpod"} gpuDefault={s?.gpuProvider} />
              ) : category === "vast" ? (
                <VastPanel fid={fid} active={section === "vast"} gpuDefault={s?.gpuProvider} />
              ) : category === "daytona" ? (
                <DaytonaPanel fid={fid} active={section === "daytona"} gpuDefault={s?.gpuProvider} />
              ) : category === "docker" ? (
                <DockerPanel fid={fid} active={section === "docker"} />
              ) : category === "machines" ? (
                <MachinesPanel fid={fid} />
              ) : category === "hooks" ? (
                <Panel section="hooks">
                  <HooksPanel projectId={null} intro={false} />
                </Panel>
              ) : category === "projects" ? (
                <Panel section="projects"><SettingsField label="Projects" keywords="configure repository project settings"><ProjectSettingsPicker /></SettingsField></Panel>
              ) : category === "appearance" ? (
                <AppearancePanel />
              ) : category === "about" ? (
                <AboutPanel onReset={() => void resetAll()} resetting={reset.isPending} />
              ) : !s ? (
                <Panel section={category}><Loading label="Loading settings" /></Panel>
              ) : category === "orchestrator" ? (
                <Panel section="orchestrator">
                  <Row
                    id={fid("ocli")}
                    label="Agent"
                    help={<>The coding agent the Coordinator chat runs on; Codex needs a Codex login in <SettingsLink section="credentials">Settings › Credentials</SettingsLink>.</>}
                    {...row("orchestratorCli")}
                  >
                    <AgentCliSelect id={fid("ocli")} clis={MANAGER_CLIS} value={s.orchestratorCli} onChange={(v) => set("orchestratorCli", v)} testId="orchestrator-cli" />
                  </Row>
                  {s.orchestratorCli === "codex" ? (
                    <Row
                      id={fid("ocm")}
                      label="Codex model"
                      help="The OpenAI model the Coordinator runs on; leave it empty for Codex's own default."
                      {...row("orchestratorCodexModel")}
                    >
                      <CodexModelSelect id={fid("ocm")} value={s.orchestratorCodexModel} onChange={(v) => set("orchestratorCodexModel", v)} testId="orchestrator-codex-model" />
                    </Row>
                  ) : (
                    <Row
                      id={fid("om")}
                      label="Model"
                      help="The Claude model the Coordinator chat runs on."
                      more="Its quick questions use it too, unless Quick questions below picks one. Pick a model or alias, or enter a custom model ID."
                      {...row("orchestratorModel")}
                    >
                      <ModelPicker id={fid("om")} value={s.orchestratorModel} onChange={(v) => set("orchestratorModel", v)} testId="orchestrator-model" customInputProps={field("orchestratorModel")} />
                    </Row>
                  )}
                  <Row id={fid("oe")} label="Effort" help="How hard it thinks before answering. Higher is slower and costs more." {...row("orchestratorEffort")}>
                    <EffortPicker
                      id={fid("oe")}
                      cli={s.orchestratorCli}
                      model={s.orchestratorCli === "codex" ? s.orchestratorCodexModel : s.orchestratorModel}
                      value={s.orchestratorEffort}
                      onChange={(v) => set("orchestratorEffort", v as Settings["orchestratorEffort"])}
                      testId="orchestrator-effort"
                    />
                  </Row>
                  <Row
                    id={fid("oac")}
                    label="Auto-compact"
                    help="Compacts the Coordinator and every Captain between turns once context usage passes this." more={`A summary is saved to the compaction log first and shown again after the compaction. Default: ${DEFAULT_AUTOCOMPACT_TOKENS / 1000}k tokens; every turn re-sends the whole context, so a lower threshold makes turns cheaper. Off: only the CLI's own last-resort compaction near the window limit.`}
                    {...row("orchestratorAutoCompact")}
                  >
                    <AutoCompactControl
                      id={fid("oac")}
                      label="Coordinator auto-compact"
                      value={s.orchestratorAutoCompact}
                      onChange={(v) => set("orchestratorAutoCompact", v)}
                      tokens={DEFAULT_AUTOCOMPACT_TOKENS}
                      field={field("orchestratorAutoCompact")}
                    />
                  </Row>
                  {/* Relay turns switch to a lighter Claude model; a Coordinator on Codex keeps its one model. */}
                  {s.orchestratorCli !== "codex" && (
                    <Row
                      id={fid("orl")}
                      label="Relay turns"
                      help="Runs the Coordinator's relay-only turns (woken by task updates and Captain replies, with no message from you) on a model and effort of their own." more="Off by default: another model or effort can't reuse the last turn's prompt cache, so each relay turn sends the whole context again. That's quick and cheap on a small model, slow and costly on a big one. Your own messages always use the model above."
                      {...row("orchestratorRelay", ["orchestratorRelay.model"])}
                    >
                      <div className="space-y-2">
                        <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300">
                          <input
                            id={fid("orl")}
                            type="checkbox"
                            checked={s.orchestratorRelay.enabled}
                            onChange={(e) => set("orchestratorRelay", { ...s.orchestratorRelay, enabled: e.target.checked })}
                            data-testid="orchestrator-relay"
                          />
                          {s.orchestratorRelay.enabled ? "On: relay turns use this" : "Off: every turn uses the model above"}
                        </label>
                        {/* The pickers only while it's on (or its model needs a fix): off, one line says what it would use. */}
                        {s.orchestratorRelay.enabled || problems["orchestratorRelay.model"] ? (
                          <>
                            <ModelPicker
                              value={s.orchestratorRelay.model}
                              onChange={(v) => set("orchestratorRelay", { ...s.orchestratorRelay, model: v })}
                              disabled={!s.orchestratorRelay.enabled}
                              ariaLabel="Relay turn model"
                              testId="orchestrator-relay-model"
                              customInputProps={field("orchestratorRelay.model")}
                            />
                            <EffortPicker
                              value={s.orchestratorRelay.effort}
                              onChange={(v) => set("orchestratorRelay", { ...s.orchestratorRelay, effort: v as Settings["orchestratorEffort"] })}
                              model={s.orchestratorRelay.model}
                              disabled={!s.orchestratorRelay.enabled}
                              ariaLabel="Relay turn effort"
                              testId="orchestrator-relay-effort"
                            />
                          </>
                        ) : (
                          <p className="text-xs text-zinc-500" data-testid="orchestrator-relay-resolved">
                            Uses {modelName(s.orchestratorRelay.model)} · {EFFORT_LABEL[s.orchestratorRelay.effort]} when on.
                          </p>
                        )}
                      </div>
                    </Row>
                  )}
                  <h4 data-settings-context className="mt-6 border-t border-zinc-900 pt-5 text-sm font-semibold text-zinc-100">Project Captains</h4>
                  <p data-settings-context className="mt-1 mb-4 text-xs leading-relaxed text-zinc-500">
                    Each project's Captain wakes on its task events, so it runs far more often than the Coordinator. Set its agent, model and effort separately to tune that cost.
                    Captains share the auto-compact threshold above. The icon below is every Captain's look; a project can pick its own in its settings.
                  </p>
                  <Row
                    id={fid("ccli")}
                    label="Captain agent"
                    help={<>The coding agent every project's Captain runs on; Codex needs a Codex login in <SettingsLink section="credentials">Settings › Credentials</SettingsLink>.</>}
                    {...row("captainCli")}
                  >
                    <AgentCliSelect id={fid("ccli")} clis={MANAGER_CLIS} value={s.captainCli} onChange={(v) => set("captainCli", v)} testId="captain-cli" />
                  </Row>
                  {s.captainCli === "codex" ? (
                    <Row
                      id={fid("ccm")}
                      label="Captain Codex model"
                      help="The OpenAI model every Captain runs on; leave it empty for Codex's own default."
                      {...row("captainCodexModel")}
                    >
                      <CodexModelSelect id={fid("ccm")} value={s.captainCodexModel} onChange={(v) => set("captainCodexModel", v)} testId="captain-codex-model" />
                    </Row>
                  ) : (
                    <Row
                      id={fid("cm")}
                      label="Captain model"
                      help="The Claude model every project Captain runs on."
                      more="Their quick questions use it too, unless Quick questions below picks one. Pick a model or alias, or enter a custom model ID."
                      {...row("captainModel")}
                    >
                      <ModelPicker id={fid("cm")} value={s.captainModel} onChange={(v) => set("captainModel", v)} testId="captain-model" customInputProps={field("captainModel")} />
                    </Row>
                  )}
                  <Row id={fid("ce")} label="Captain effort" help="How hard Captains think before answering. Lower is faster and cheaper." {...row("captainEffort")}>
                    <EffortPicker
                      id={fid("ce")}
                      cli={s.captainCli}
                      model={s.captainCli === "codex" ? s.captainCodexModel : s.captainModel}
                      value={s.captainEffort}
                      onChange={(v) => set("captainEffort", v as Settings["captainEffort"])}
                      testId="captain-effort"
                    />
                  </Row>
                  <Row
                    id={fid("cicon")}
                    label="Captain icon"
                    help="What every project's Captain shows in the sidebar, its chat and its messages, in its project's colour."
                    more="A project's settings can pick its own; one with an uploaded image and no pick shows the image."
                    {...row("captainIcon")}
                  >
                    <CaptainIconPicker id={fid("cicon")} value={s.captainIcon} onChange={(v) => v && set("captainIcon", v)} testId="captain-icon" />
                  </Row>
                  <h4 data-settings-context className="mt-6 border-t border-zinc-900 pt-5 text-sm font-semibold text-zinc-100">Quick questions</h4>
                  <p data-settings-context className="mt-1 mb-4 text-xs leading-relaxed text-zinc-500">
                    A task's side questions, and Reply and Ask on the Coordinator's and Captains' messages. Each one answers read-only beside its chat, which never sees it. By
                    default they run on their chat's model and effort; a small model like Haiku answers sooner and costs less.
                  </p>
                  <Row
                    id={fid("qqm")}
                    label="Quick question model"
                    changed={changed.includes("quickQuestionModel")}
                    help="The Claude model quick questions run on." more="Same as chat: the Coordinator's model in its chat and for a task's side questions, the Captain model in a Captain's chat. Another model can't reuse the chat's prompt cache, so a thread's first answer reads the chat's whole context again, which is cheap on Haiku. A chat on Codex keeps its own model."
                    hint={
                      <>
                        {/* The option says only "Same as chat", so it fits a phone: which model that is goes here. */}
                        {!s.quickQuestionModel && (
                          <span className="basis-full text-xs text-zinc-500" data-testid="quick-question-model-resolved">
                            {s.orchestratorModel === s.captainModel ? `Uses ${modelName(s.orchestratorModel)}.` : `Uses ${modelName(s.orchestratorModel)} for the Coordinator, ${modelName(s.captainModel)} for Captains.`}
                          </span>
                        )}
                        {row("quickQuestionModel").hint}
                      </>
                    }
                  >
                    <ModelPicker
                      id={fid("qqm")}
                      value={s.quickQuestionModel}
                      onChange={(v) => set("quickQuestionModel", v)}
                      defaultLabel="Same as chat"
                      testId="quick-question-model"
                      customInputProps={field("quickQuestionModel")}
                    />
                  </Row>
                  <Row
                    id={fid("qqe")}
                    label="Quick question effort"
                    help="How hard quick questions think before answering. Same as chat: the Coordinator's or Captain effort above."
                    {...row("quickQuestionEffort")}
                  >
                    <EffortPicker
                      id={fid("qqe")}
                      value={s.quickQuestionEffort}
                      onChange={(v) => set("quickQuestionEffort", v as Settings["quickQuestionEffort"])}
                      model={s.quickQuestionModel}
                      effective={s.quickQuestionEffort || s.orchestratorEffort}
                      lead={<option value="">Same as chat{s.orchestratorEffort === s.captainEffort ? ` (${EFFORT_LABEL[s.orchestratorEffort]})` : ""}</option>}
                      testId="quick-question-effort"
                    />
                  </Row>
                  <h4 data-settings-context className="mt-6 border-t border-zinc-900 pt-5 text-sm font-semibold text-zinc-100">Project notes</h4>
                  <p data-settings-context className="mt-1 mb-4 text-xs leading-relaxed text-zinc-500">
                    Every agent in a project starts with its notes. Agents only suggest notes; each project's Captain curates them into a small set of lasting rules, and you can edit
                    them on the project's Notes tab.
                  </p>
                  <Row
                    id={fid("nre")}
                    label="Notes retro"
                    help="When a task's PR merges, or a task without a PR ends done, its project's Captain decides on each note suggestion the agent left."
                    more="It accepts, merges or rejects each one, with a one-line reason. Nobody needs to approve them; the Notes tab shows what was decided."
                    {...row("notesRetroEnabled")}
                  >
                    <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300">
                      <input id={fid("nre")} type="checkbox" checked={s.notesRetroEnabled} onChange={(e) => set("notesRetroEnabled", e.target.checked)} data-testid="notes-retro" />
                      {s.notesRetroEnabled ? "On: Captains curate suggestions" : "Off: suggestions stay pending until it's on again"}
                    </label>
                  </Row>
                  <Row
                    id={fid("nmc")}
                    label="Max notes"
                    help="Most notes an agent's first prompt gets; Captains keep their project under it." more="Over it, agents get the newest notes that fit, their prompt says how many were left out, and the Captain is asked to prune. A project can set its own on its Settings tab."
                    {...row("notesMaxCount")}
                  >
                    <input
                      id={fid("nmc")}
                      type="number"
                      min={NOTE_BUDGET_LIMITS.maxNotes.min}
                      max={NOTE_BUDGET_LIMITS.maxNotes.max}
                      className={inputClass}
                      value={numberText(s.notesMaxCount)}
                      onChange={(e) => set("notesMaxCount", typedNumber(e.target.value, true))}
                      {...field("notesMaxCount")}
                    />
                  </Row>
                  <Row id={fid("nmt")} label="Max note tokens" help="About how many tokens all the notes may take in that prompt, next to Max notes (4 characters is about 1 token)." {...row("notesMaxTokens")}>
                    <input
                      id={fid("nmt")}
                      type="number"
                      min={NOTE_BUDGET_LIMITS.maxTokens.min}
                      max={NOTE_BUDGET_LIMITS.maxTokens.max}
                      step={100}
                      className={inputClass}
                      value={numberText(s.notesMaxTokens)}
                      onChange={(e) => set("notesMaxTokens", typedNumber(e.target.value, true))}
                      {...field("notesMaxTokens")}
                    />
                  </Row>
                  <h4 data-settings-context className="mt-6 border-t border-zinc-900 pt-5 text-sm font-semibold text-zinc-100">When a task's PR merges</h4>
                  <p data-settings-context className="mt-1 mb-4 text-xs leading-relaxed text-zinc-500">
                    Box Yard checks open PRs with GitHub about once a minute, with each project's own token. A project can turn either of these off (or on) in its settings, and a task can stay open from its details (ⓘ). Hooks on "PR merged" still run too, right after.
                  </p>
                  <Row
                    id={fid("adm")}
                    label="Done when its PR merges"
                    help="When a task's pull request merges and its turn is over (it's idle or waiting for review), it moves to done and its workspace is archived, as Mark done does." more="It stays as it is while messages are queued for it, while it has another PR open, or when it's set to stay open. Turning it on also moves resting tasks whose PR has already merged. Off: a merged PR leaves its task idle until you mark it done. Messaging a done task picks it back up."
                    {...row("autoDoneOnMerge")}
                  >
                    <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300">
                      <input id={fid("adm")} type="checkbox" checked={s.autoDoneOnMerge ?? true} onChange={(e) => set("autoDoneOnMerge", e.target.checked)} data-testid="auto-done-on-merge" />
                      {(s.autoDoneOnMerge ?? true) ? "On: a merged PR moves its task to done" : "Off: you mark tasks done yourself"}
                    </label>
                  </Row>
                  <Row
                    id={fid("cim")}
                    label="Close the issues it names"
                    help="When a PR merges into a branch other than the repo's default (an epic branch), Box Yard closes the issues it names with Fixes, Closes or Resolves #N."
                    more="GitHub closes them itself only on a merge into the default branch. Box Yard closes open issues of the same repo only, never PRs or other repos' issues, each with a comment linking the PR."
                    {...row("closeIssuesOnMerge")}
                  >
                    <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300">
                      <input id={fid("cim")} type="checkbox" checked={s.closeIssuesOnMerge ?? true} onChange={(e) => set("closeIssuesOnMerge", e.target.checked)} data-testid="close-issues-on-merge" />
                      {(s.closeIssuesOnMerge ?? true) ? "On: closed after a merge into an epic branch, with a comment" : "Off: only GitHub closes them (default branch)"}
                    </label>
                  </Row>
                  <h4 data-settings-context className="mt-6 border-t border-zinc-900 pt-5 text-sm font-semibold text-zinc-100">New comments on open PRs</h4>
                  <p data-settings-context className="mt-1 mb-4 text-xs leading-relaxed text-zinc-500">
                    A task with an open PR shows how many comments were written since you last opened the PR from a link in Box Yard. Opening the PR again reads them.
                  </p>
                  <Row
                    id={fid("pcm")}
                    label="New PR comments"
                    help="How often Box Yard asks GitHub, in the background, for the comments on every open PR. An open task's own PR is also asked when you open the task and every minute while it stays open."
                    more={`Counted: conversation comments, reviews with a summary and comments in unresolved review threads, written after your last visit (all of them for a PR you never opened from here). Not counted: the PR author's and the project's GitHub account's own comments, resolved threads, and merged or closed PRs. Every ${PR_COMMENT_MINUTES.default} minutes costs about 12 of a token's 5,000 GitHub points an hour per 100 open PRs, plus half a point for each PR that changed; it pauses by itself when a token runs low. Off never asks and hides the counts.`}
                    {...row("prCommentMinutes")}
                  >
                    <Select
                      id={fid("pcm")}
                      className="w-full"
                      value={String(s.prCommentMinutes ?? PR_COMMENT_MINUTES.default)}
                      onChange={(e) => set("prCommentMinutes", Number(e.target.value))}
                      data-testid="pr-comment-minutes"
                    >
                      {PR_COMMENT_MINUTES.options.map((m) => (
                        <option key={m} value={m}>
                          {prCommentMinutesLabel(m)}
                        </option>
                      ))}
                    </Select>
                  </Row>
                </Panel>
              ) : category === "agents" ? (
                <Panel section="agents">
                  <Row
                    id={fid("on")}
                    label="Your name"
                    help="What the Coordinator, Captains and agents call you in their prompts and labels. Until you save a name, that’s “the owner”."
                    {...row("ownerName")}
                  >
                    {/* Never saved: the default is the placeholder, not a name someone typed, and emptying the field goes back to it. */}
                    <input
                      id={fid("on")}
                      className={inputClass}
                      value={current?.sources.ownerName === "default" && !changed.includes("ownerName") ? "" : s.ownerName}
                      placeholder={DEFAULT_OWNER_NAME}
                      maxLength={40}
                      onChange={(e) => set("ownerName", e.target.value || (current?.sources.ownerName === "default" ? current.settings.ownerName : ""))}
                      {...field("ownerName")}
                    />
                  </Row>
                  <Row
                    id={fid("acli")}
                    label="Agent"
                    help="The coding agent new tasks run on: a project can pick its own." more="Existing tasks keep their saved harness; use Continue with… on a resting task to switch it explicitly. A new task given provider/model runs on OpenCode, one given a gpt-* model runs on Codex, and one given a Cursor-only model (composer-2.5, gemini-…) on Cursor."
                    {...row("agentCli")}
                  >
                    <AgentCliSelect id={fid("acli")} clis={AGENT_CLIS} value={s.agentCli} onChange={(v) => set("agentCli", v)} testId="agent-cli" />
                  </Row>
                  {s.agentCli === "opencode" ? (
                    <Row id={fid("aoc")} label="OpenCode model" help="Provider and model for OpenCode tasks. An optional #variant selects provider-specific reasoning. Generic effort and Box Yard compaction thresholds do not apply." {...row("agentOpencodeModel")}>
                      <OpenCodeModelInput id={fid("aoc")} value={s.agentOpencodeModel} onChange={(v) => set("agentOpencodeModel", v)} testId="agent-opencode-model" />
                    </Row>
                  ) : s.agentCli === "cursor" ? (
                    <Row
                      id={fid("acu")}
                      label="Cursor model"
                      help="The model tasks on Cursor run on, unless the task or its project's Routing YAML entry picks one Cursor has." more="Auto lets Cursor pick per request. Cursor's ids carry the effort, so there's no separate Effort here, and Cursor compacts its context on its own."
                      {...row("agentCursorModel")}
                    >
                      <CursorModelSelect id={fid("acu")} value={s.agentCursorModel} onChange={(v) => set("agentCursorModel", v)} testId="agent-cursor-model" />
                    </Row>
                  ) : s.agentCli === "codex" ? (
                    <Row id={fid("acm")} label="Codex model" help="The model tasks on Codex run on, unless the task or its project's Routing YAML entry picks one. Options depend on your Codex account and CLI version." {...row("agentCodexModel")}>
                      <CodexModelSelect id={fid("acm")} value={s.agentCodexModel} onChange={(v) => set("agentCodexModel", v)} testId="agent-codex-model" />
                    </Row>
                  ) : (
                    <Row id={fid("am")} label="Model" help="The Claude model each task's agent runs on, unless the task or its project's Routing YAML entry picks one." more="Once saved here or set by an env var, it wins over the YAML's defaults and fallback." {...row("agentModel")}>
                      <ModelPicker id={fid("am")} value={s.agentModel} onChange={(v) => set("agentModel", v)} testId="agent-model" customInputProps={field("agentModel")} />
                    </Row>
                  )}
                  {hasSeparateEffort(s.agentCli) && (
                    <Row
                      id={fid("ae")}
                      label="Effort"
                      help={
                        (s.agentCli === "codex" ? s.agentCodexEffort : s.agentEffort) === "orchestrator"
                          ? "The Coordinator picks an effort in create_task and send_to_task: low for one-command chores, high for real coding."
                          : "Every agent turn uses this effort, unless the task or its project's Routing YAML entry picks one."
                      }
                      more={
                        (s.agentCli === "codex" ? s.agentCodexEffort : s.agentEffort) === "orchestrator"
                          ? "Without one, Routing YAML or the harness default applies."
                          : "Once saved here or set by an env var, it wins over the YAML's defaults and fallback."
                      }
                      {...row(s.agentCli === "codex" ? "agentCodexEffort" : "agentEffort")}
                    >
                      <EffortPicker
                        id={fid("ae")}
                        cli={s.agentCli}
                        model={s.agentCli === "codex" ? s.agentCodexModel : s.agentModel}
                        value={s.agentCli === "codex" ? s.agentCodexEffort : s.agentEffort}
                        onChange={(v) => set(s.agentCli === "codex" ? "agentCodexEffort" : "agentEffort", v as AgentEffort)}
                        lead={<option value="orchestrator">Let the Coordinator decide</option>}
                        testId="agent-effort"
                      />
                    </Row>
                  )}
                  <Row
                    id={fid("arc")}
                    label="Routing YAML"
                    help="Optional rules for task model and effort, also read from routing.yaml in the data directory." more="Each turn the first match wins: the task's own choice, then its project's entry, then Model and Effort above when saved or set by an env var, then defaults, then fallback, then the harness default (OpenCode: provider/model above, no generic effort; Codex: gpt-6.1-sol at extra high; Claude: claude-opus-5-5 at high; Cursor: its Cursor model above, which only takes ids Cursor lists)."
                    {...row("agentRoutingConfig")}
                  >
                    <textarea
                      id={fid("arc")}
                      className={cx(inputClass, "min-h-40 resize-y font-mono text-xs leading-5")}
                      spellCheck={false}
                      value={s.agentRoutingConfig}
                      onChange={(e) => set("agentRoutingConfig", e.target.value)}
                      placeholder={"fallback:\n  model: claude-opus-5-5\n  effort: high\nrules:\n  - name: docs-small-fixes\n    when: docs, typos, small fixes\n    model: claude-haiku-5-5\n    effort: low"}
                    />
                  </Row>
                  <Row
                    id={fid("aac")}
                    label="Custom auto-compact threshold"
                    help="Passed to each agent's CLI as its auto-compact window (100k–1M tokens). Off: the CLI's own default."
                    {...row("agentAutoCompact")}
                  >
                    <AutoCompactControl id={fid("aac")} label="Agent auto-compact" value={s.agentAutoCompact} onChange={(v) => set("agentAutoCompact", v)} field={field("agentAutoCompact")} />
                  </Row>
                  <Row
                    id={fid("smd")}
                    label="Sub-task depth"
                    help="How deep sub-tasks may nest. An agent splits its work with spawn_subtasks; each sub-task runs as a task of its own and reports back. 1: a sub-task can't start its own."
                    {...row("subtaskMaxDepth")}
                  >
                    <input
                      id={fid("smd")}
                      type="number"
                      min={SUBTASK_MAX_DEPTH.min}
                      max={SUBTASK_MAX_DEPTH.max}
                      className={inputClass}
                      value={numberText(s.subtaskMaxDepth ?? SUBTASK_MAX_DEPTH.default)}
                      onChange={(e) => set("subtaskMaxDepth", typedNumber(e.target.value, true))}
                      {...field("subtaskMaxDepth")}
                    />
                  </Row>
                  <Row id={fid("smc")} label="Sub-tasks per task" help="How many sub-tasks one task may start, over its whole life." {...row("subtaskMaxChildren")}>
                    <input
                      id={fid("smc")}
                      type="number"
                      min={SUBTASK_MAX_CHILDREN.min}
                      max={SUBTASK_MAX_CHILDREN.max}
                      className={inputClass}
                      value={numberText(s.subtaskMaxChildren ?? SUBTASK_MAX_CHILDREN.default)}
                      onChange={(e) => set("subtaskMaxChildren", typedNumber(e.target.value, true))}
                      {...field("subtaskMaxChildren")}
                    />
                  </Row>
                </Panel>
              ) : category === "limits" ? (
                <LimitsPanel s={s} set={set} row={row} field={field} fid={fid} sources={current?.sources} resets={resets} />
              ) : (
                <CostsPanel s={s} set={set} row={row} field={field} fid={fid} />
              )}
            </div>
          ))}
        </SettingsDraftContext.Provider>
      </SettingsTabs>
      </SettingsSearchProvider>
    </Modal>
  )
}

// ------------------------------------------------------------------ panels

function LimitsPanel({
  s,
  set,
  row,
  field,
  fid,
  sources,
  resets,
}: {
  s: Settings
  set: <K extends keyof Settings>(k: K, v: Settings[K]) => void
  row: RowMeta
  field: FieldCheck
  fid: (k: string) => string
  sources?: Record<keyof Settings, SettingSource>
  resets: (keyof Settings)[]
}) {
  const health = useHealth()
  const server = useSettings()
  // A number field's value and draft. Emptied, it's NaN until a number is typed, so Save asks instead of saving 0.
  const num = (k: NumberKey) => ({
    value: numberText(s[k]),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(k, typedNumber(e.target.value, NUMBER_RULES[k]?.whole)),
    ...field(k),
  })
  const capacity = agentCapacity(s)
  // A pending "Use size default" shows the size defaults already.
  const shownSources = sources && { ...sources, ...Object.fromEntries(resets.map((k) => [k, "default"])) }
  const upstash = health.data?.provider === "upstash"
  return (
    <Panel section="limits">
      {/* Rarely touched: open when one of them isn't the default, so a ceiling set on purpose (or by env) shows. */}
      <details
        className="border-t border-zinc-900 py-4"
        data-testid="limits-advanced"
        open={(["maxBoxes", "boxCreateConcurrency"] as const).some((k) => shownSources?.[k] && shownSources[k] !== "default") || undefined}
      >
        <summary className="cursor-pointer text-sm font-medium text-zinc-300 select-none hover:text-zinc-100">Advanced: box ceiling and how fast boxes are made</summary>
        <div className="mt-4">
          <Row
            id={fid("mb")}
            label="Max boxes (safety ceiling)"
            help="A safety stop, not a budget: the most worker boxes alive at once, however much work waits."
            more={<>What keeps spend in check is the daily cloud limit (<SettingsLink section="costs">Settings › Usage</SettingsLink>); boxes start when work needs one and are deleted when idle.</>}
            {...row("maxBoxes")}
          >
            <input id={fid("mb")} type="number" min={1} max={100} className={inputClass} {...num("maxBoxes")} data-testid="max-boxes" />
          </Row>
          <Row
            id={fid("bcc")}
            label="Boxes created at once"
            help="When many tasks wait for a box (say a Captain starts a batch of tasks), Box Yard creates up to this many boxes in parallel, still within Max boxes." more="Lower it if your box provider rate-limits box creation; Box Yard also backs off by itself when a create fails or is rate-limited."
            {...row("boxCreateConcurrency")}
          >
            <input
              id={fid("bcc")}
              type="number"
              min={BOX_CREATE_CONCURRENCY.min}
              max={BOX_CREATE_CONCURRENCY.max}
              className={inputClass}
              {...num("boxCreateConcurrency")}
              data-testid="box-create-concurrency"
            />
          </Row>
        </div>
      </details>
      <Row id={fid("ma")} label="Max tasks running at once" help="A cap on tasks running at once across all boxes. 0 = boxes × tasks running at once per box." {...row("maxAgents")}>
        <input id={fid("ma")} type="number" min={0} max={1000} className={inputClass} {...num("maxAgents")} />
      </Row>
      <Row id={fid("bid")} label="Idle box deletion" help="Delete an idle worker box after this many minutes, but only when every resident workspace has a fresh archive. 0 keeps boxes." {...row("boxIdleDeleteMinutes")}>
        <input id={fid("bid")} type="number" min={0} max={43_200} className={inputClass} {...num("boxIdleDeleteMinutes")} />
      </Row>
      <Row
        id={fid("wrd")}
        label="Workspace retention"
        help="After this many idle days, archived resting task folders are removed from boxes and restored from the archive on the next message. 0 keeps folders."
        {...row("workspaceRetentionDays")}
      >
        <input id={fid("wrd")} type="number" min={0} max={3650} className={inputClass} {...num("workspaceRetentionDays")} />
      </Row>
      <Row
        id={fid("ard")}
        label="Archive retention"
        help="After this many days, orphan archives and long-done task archives are pruned. 0 keeps archives." more="Archives of tasks with an open or unmerged PR are always kept. A done task whose archive was pruned restarts from a recap on its next message."
        {...row("archiveRetentionDays")}
      >
        <input id={fid("ard")} type="number" min={0} max={3650} className={inputClass} {...num("archiveRetentionDays")} />
      </Row>
      <Row
        id={fid("akt")}
        label="Keep recent archives"
        help="Never prune the archive of a task touched in the last this many days, so recent work resumes with its full session. 0 = only archive retention applies."
        {...row("archiveKeepTouchedDays")}
      >
        <input id={fid("akt")} type="number" min={0} max={3650} className={inputClass} {...num("archiveKeepTouchedDays")} />
      </Row>
      <Row
        id={fid("dmf")}
        label="Disk headroom (MB)"
        help="A new workspace only lands on a box with at least this much free disk. A box below it is cleaned up in the background while tasks go to another box."
        {...row("diskMinFreeMb")}
      >
        <input id={fid("dmf")} type="number" min={0} max={1_000_000} step={128} className={inputClass} {...num("diskMinFreeMb")} />
      </Row>
      <Row
        id={fid("dcf")}
        label="Clone size factor"
        help="...and at least this many times the repo's last clone size, for big repos (the clone plus the box's shared mirror of it)."
        {...row("diskCloneFactor")}
      >
        <input
          id={fid("dcf")}
          type="number"
          min={1}
          max={20}
          step={0.5}
          className={inputClass}
          {...num("diskCloneFactor")}
        />
      </Row>
      <Row
        id={fid("mup")}
        label="Memory limit (% used)"
        help="A new agent skips a box with more than this much of its memory in use while other agents run on it, and goes to another box (or waits). 0 = off."
        more="Memory is read from the box's cgroup without the reclaimable page cache."
        {...row("memoryMaxUsedPercent")}
      >
        <input id={fid("mup")} type="number" min={0} max={100} step={5} className={inputClass} {...num("memoryMaxUsedPercent")} data-testid="memory-max-used" />
      </Row>
      <Row id={fid("mmf")} label="Memory headroom (MB)" help="...or with less than this much memory free. 0 = off." {...row("memoryMinFreeMb")}>
        <input id={fid("mmf")} type="number" min={0} max={1_000_000} step={256} className={inputClass} {...num("memoryMinFreeMb")} />
      </Row>
      <Row
        id={fid("lpc")}
        label="Load limit (per CPU)"
        help="...or with a 1-minute load average above this many times its CPUs (nproc). On Upstash, /proc/loadavg and nproc describe the host the box runs on. 0 = off."
        {...row("loadMaxPerCpu")}
      >
        <input
          id={fid("lpc")}
          type="number"
          min={0}
          max={100}
          step={0.5}
          className={inputClass}
          {...num("loadMaxPerCpu")}
        />
      </Row>
      <Row
        id={fid("bci")}
        label="Build output cleanup (idle minutes)"
        help="Once a done task has sat idle this long, its git-ignored build output is removed from its Upstash box. 0 = off." more="Build output is node_modules, dist, .cache, tmp and perf captures; this computer and SSH machines have their own settings below, and low-disk cleanup still runs at 0. A task that isn't done keeps it, and so does a folder a process still uses (a dev server, a shell); only low-disk cleanup frees an idle task's build output, and the task's log says what went. Only folders git ignores and doesn't track; uncommitted work is never touched."
        {...row("buildCleanupIdleMinutes")}
      >
        <input id={fid("bci")} type="number" min={0} max={43_200} className={inputClass} {...num("buildCleanupIdleMinutes")} />
      </Row>
      <Row
        id={fid("dce")}
        label="Dependency cache (npm)"
        help="Each box keeps the node_modules its agents installed, one per package-lock.json, next to the task folders." more="A task with that lockfile and no node_modules (a fresh clone, or one the build output cleanup emptied) gets it hard-linked in before its turn, in under a second, and its prompt says it needn't run npm ci. The shared files are read-only, so a task can't change another's. A project can override it."
        {...row("depCacheEnabled")}
      >
        <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300">
          <input id={fid("dce")} type="checkbox" checked={s.depCacheEnabled} onChange={(e) => set("depCacheEnabled", e.target.checked)} data-testid="dep-cache" />
          {s.depCacheEnabled ? "On: node_modules restored from the box cache" : "Off: agents install dependencies"}
        </label>
      </Row>
      <Row
        id={fid("dcm")}
        label="Dependency cache size (MB)"
        help="Most work-disk space one box's cache may hold. Over it, the least recently used lockfiles no task links go first. Low-disk cleanup also removes entries no task links."
        {...row("depCacheMaxMb")}
      >
        <input id={fid("dcm")} type="number" min={100} max={1_000_000} step={256} className={inputClass} disabled={!s.depCacheEnabled} {...num("depCacheMaxMb")} data-testid="dep-cache-max" />
      </Row>
      <Row
        id={fid("gpc")}
        label="Partial clone mirrors"
        help="Each box keeps one mirror per repo, and task checkouts borrow its objects instead of copying them."
        more="With this on, mirrors skip old file versions (git clone --filter=blob:none); git fetches one from GitHub when log -p, blame or a checkout needs it. A project can override it."
        {...row("gitPartialClone")}
      >
        <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300">
          <input id={fid("gpc")} type="checkbox" checked={s.gitPartialClone} onChange={(e) => set("gitPartialClone", e.target.checked)} data-testid="git-partial-clone" />
          {s.gitPartialClone ? "On: blob:none mirrors" : "Off: full mirrors"}
        </label>
      </Row>
      <Row
        id={fid("gpt")}
        label="Push at turn end"
        help="After every agent turn in a repo project, Box Yard pushes the task's branch and saves uncommitted work (untracked files too) to a hidden ref on origin, refs/boxyard/wip/<task>, without committing in the task's repo." more="Archives then carry only what git can't, so a box can go at any time without losing code. Without write access it quietly keeps full archives. A project can override it."
        {...row("gitPushAtTurnEnd")}
      >
        <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300">
          <input id={fid("gpt")} type="checkbox" checked={s.gitPushAtTurnEnd} onChange={(e) => set("gitPushAtTurnEnd", e.target.checked)} data-testid="git-push-at-turn-end" />
          {s.gitPushAtTurnEnd ? "On: branch and WIP pushed, small archives" : "Off: full archives"}
        </label>
      </Row>
      <h4 data-settings-context className="mt-6 border-t border-zinc-900 pt-5 text-sm font-semibold text-zinc-100" data-testid="limits-own-computers">
        This computer and SSH machines
      </h4>
      <p data-settings-context className="mt-1 mb-4 text-xs leading-relaxed text-zinc-500">
        Task folders on your own computers aren't boxes, so the box cleanup above doesn't reach them. These settings do. They never touch a running, queued or starting task,
        one waiting for an answer, a folder a process still uses (a dev server, an editor, a shell), or one with anything uncommitted, stashed or unpushed. Only done tasks'
        folders leave, archived first, and come back on their next message. Whatever goes is written to the task's log.
      </p>
      <Row
        id={fid("la")}
        label="Tasks running at once on this computer"
        help={`Tasks of projects that run on this computer (project settings › Runs on) that may run at once here, every project's together; a project's own Tasks running at once limits only its own tasks within this. ${LOCAL_UNSANDBOXED}`} more={`They have their own queue: they never take a box slot or count toward Max tasks running at once. Each task works in its own folder in ${server.data?.localDir ?? "~/boxyard-workspaces"} (BOXYARD_LOCAL_DIR).`}
        {...row("localAgents")}
      >
        <input
          id={fid("la")}
          type="number"
          min={LOCAL_AGENTS_LIMITS.min}
          max={LOCAL_AGENTS_LIMITS.max}
          className={inputClass}
          {...num("localAgents")}
          data-testid="local-agents"
        />
      </Row>
      <Row
        id={fid("lfk")}
        label="Task folders kept on this computer"
        help={`Most task folders in ${server.data?.localDir ?? "~/boxyard-workspaces"}, and on each SSH machine. 0 = no limit.`}
        more="Past it, the oldest done tasks' folders are archived and removed, but only when all their work is pushed. A task that isn't done keeps its folder."
        {...row("localFoldersKept")}
      >
        <input id={fid("lfk")} type="number" min={0} max={1000} className={inputClass} {...num("localFoldersKept")} data-testid="local-folders-kept" />
      </Row>
      <Row
        id={fid("lbc")}
        label="Free a finished task's build output"
        help="Once a task is done and all its work is pushed, remove the dependency and build output git ignores (node_modules, dist, build, .next, caches) from its folder within a couple of minutes." more="A task that isn't done keeps it (only low-disk cleanup frees it), and so does a folder a process still uses. Scratch folders and captures (tmp, shots, perf, reports) stay. The task's log and the agent's next prompt say what went, so it reinstalls first."
        {...row("localBuildCleanup")}
      >
        <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300">
          <input id={fid("lbc")} type="checkbox" checked={s.localBuildCleanup} onChange={(e) => set("localBuildCleanup", e.target.checked)} data-testid="local-build-cleanup" />
          {s.localBuildCleanup ? "On: freed once the work is pushed" : "Off: only low-disk cleanup frees it"}
        </label>
      </Row>
      <Row
        id={fid("ldf")}
        label="Low-disk cleanup (GB free)"
        help="When the disk holding the task folders has less free space than this, Box Yard frees space until there's this much again. 0 = off."
        more="It frees build output first (an idle task's too, unless a process still uses its folder), then removes the oldest done tasks' folders. Each task's log says what went. It checks every couple of minutes."
        {...row("localDiskMinFreeGb")}
      >
        <input id={fid("ldf")} type="number" min={0} max={100_000} step={5} className={inputClass} {...num("localDiskMinFreeGb")} data-testid="local-disk-min-free" />
      </Row>
      <div className="mt-2 space-y-2 rounded-xl border border-zinc-900 bg-zinc-900/40 p-4 text-xs leading-relaxed text-zinc-400">
        <p>
          With these limits, up to <span className="font-medium text-zinc-100 tabular-nums">{capacity}</span> {capacity === 1 ? "task runs" : "tasks run"} at once on up to{" "}
          <span className="font-medium text-zinc-100 tabular-nums">{s.maxBoxes}</span> {s.maxBoxes === 1 ? "box" : "boxes"}.
        </p>
        <p>Saved changes apply right away. Lowering a limit never stops running boxes or tasks: no new work is placed until usage drops.</p>
        {upstash && (
          <p className={cx(s.maxBoxes > UPSTASH_FREE_CONCURRENT_BOXES && "text-amber-300")}>
            Free plan: up to {UPSTASH_FREE_CONCURRENT_BOXES} concurrent boxes (
            <NewTabLink className="text-sky-400 hover:underline" href="https://upstash.com/pricing/box">
              Upstash Box pricing
            </NewTabLink>
            ).
          </p>
        )}
      </div>
    </Panel>
  )
}

/** Settings › Box providers › Upstash boxes: the size new boxes get, resizing, and what each box runs and keeps. */
function UpstashBoxRows({
  s,
  set,
  row,
  field,
  fid,
  sources,
  changed,
  current,
  pin,
  resetKeys,
  resets,
}: {
  s: Settings
  set: <K extends keyof Settings>(k: K, v: Settings[K]) => void
  row: RowMeta
  field: FieldCheck
  fid: (k: string) => string
  sources?: Record<keyof Settings, SettingSource>
  changed: (keyof Settings)[]
  current?: Settings
  pin: (k: keyof Settings, on: boolean) => void
  resetKeys: (keys: (keyof Settings)[]) => void
  resets: (keyof Settings)[]
}) {
  const limitField = (k: BoxLimitKey) => ({
    k,
    value: s[k],
    current: current?.[k],
    source: sources?.[k],
    changed: changed.includes(k),
    onValue: (v: number) => set(k, v),
    pin: (on: boolean) => pin(k, on),
    onReset: () => resetKeys([k]),
    pendingReset: resets.includes(k),
    field: field(k),
  })
  // A pending "Use size default" shows the size defaults already.
  const shownSources = sources && { ...sources, ...Object.fromEntries(resets.map((k) => [k, "default"])) }
  const overrides = changed.filter((k) => !resets.includes(k))
  return (
    <>
      <Row
        id={fid("ws")}
        wide
        label="Worker size"
        help="Upstash Box size for newly created boxes."
        more="A project's own preferred size wins, and so does one auto-sizing (below) picked from its runs. Existing boxes keep their size until resized from the Boxes page."
        {...row("workerSize")}
      >
        <UpstashSizes value={s.workerSize} onPick={(size) => set("workerSize", size)} />
      </Row>
      <Row
        id={fid("are")}
        label="Size and resize boxes automatically"
        help="Box Yard sizes each project's new boxes from what its runs used, unless the project sets its own Box size." more="From 3 runs: the smallest size with RAM for 1.25 × the peak of the last 14 days, bigger for disk or busy CPU. A turn that runs out of memory carries on once on a bigger box. The Coordinator, and Captains for boxes their project uses, may also resize a box with resize_box: up when it keeps running low on disk, down when it sits mostly empty. They never stop running tasks for it, and every resize they make sends you a notice with their reason."
        {...row("autoResizeEnabled")}
      >
        <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300">
          <input id={fid("are")} type="checkbox" checked={s.autoResizeEnabled} onChange={(e) => set("autoResizeEnabled", e.target.checked)} data-testid="auto-resize" />
          {s.autoResizeEnabled ? "On: Box Yard sizes and resizes boxes" : "Off: new boxes are Worker size, and only you resize boxes"}
        </label>
      </Row>
      <Row id={fid("arm")} label="Max size it may choose" help="resize_box refuses anything bigger. You can still pick any size yourself on the Boxes page." {...row("autoResizeMaxSize")}>
        <Select
          id={fid("arm")}
          className="w-full disabled:opacity-50"
          value={s.autoResizeMaxSize}
          disabled={!s.autoResizeEnabled}
          onChange={(e) => set("autoResizeMaxSize", e.target.value as BoxSize)}
          data-testid="auto-resize-max"
        >
          {BOX_SIZES.map((size) => (
            <option key={size} value={size}>
              {BOX_SIZE_SPECS[size].label} · {BOX_SIZE_SPECS[size].cpu} vCPU · {BOX_SIZE_SPECS[size].ramGb} GB RAM
            </option>
          ))}
        </Select>
      </Row>
      <Row
        id={fid("pre")}
        label="Resize an idle box when no big-enough box is free"
        help="For projects with a box size: when the pool is at Max boxes and no box of that size has room, Box Yard may grow an idle smaller box (no agent running on it) to that size and run the task there."
        more="Larger boxes cost more. Off, the task waits for a box of its size; it never runs on a smaller one."
        {...row("placementResizeEnabled")}
      >
        <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300">
          <input
            id={fid("pre")}
            type="checkbox"
            checked={s.placementResizeEnabled}
            onChange={(e) => set("placementResizeEnabled", e.target.checked)}
            data-testid="placement-resize"
          />
          {s.placementResizeEnabled ? "On: an idle box may be resized" : "Off: the task waits"}
        </label>
      </Row>
      <SizeCapacityTable s={s} sources={shownSources} changed={overrides} />
      <Row
        id={fid("spb")}
        label="Tasks running at once per box"
        help="Tasks that may run at the same time inside one box, every project's together (each task runs its own Claude Code agent)."
        more={`A project's own Tasks running at once (project settings) limits only its own tasks within this. Unless set here, each box uses its own size's default: ${WORKER_SIZES.map((z) => `${z} ${SIZE_DEFAULTS[z].slotsPerBox}`).join(", ")}.`}
        {...row("slotsPerBox")}
      >
        <BoxLimitInput id={fid("spb")} max={20} {...limitField("slotsPerBox")} />
      </Row>
      <Row
        id={fid("mr")}
        label="Task folders kept per box"
        help={`Task folders kept on one box (running or not) before older archived workspaces are parked. Unless set here, each box uses its own size's default: ${WORKER_SIZES.map((z) => `${z} ${SIZE_DEFAULTS[z].maxResidentPerBox}`).join(", ")}.`}
        {...row("maxResidentPerBox")}
      >
        <BoxLimitInput id={fid("mr")} max={200} {...limitField("maxResidentPerBox")} />
      </Row>
    </>
  )
}

/** Tasks running at once and task folders kept per box for each worker size, so a small box's lower capacity is visible. */
type BoxLimitKey = "slotsPerBox" | "maxResidentPerBox"

/**
 * Tasks running at once or task folders kept per box. While each box follows its own size, the field shows every size's default
 * instead of one number; typing a number overrides it for every box. A value saved here gets a "Use size default"
 * button, and one set by env says how to remove it.
 */
export function BoxLimitInput({
  id,
  k,
  max,
  value,
  current,
  source,
  changed,
  onValue,
  pin,
  onReset,
  pendingReset = false,
  field,
}: {
  id: string
  k: BoxLimitKey
  max: number
  value: number
  current?: number
  source?: SettingSource
  changed: boolean
  onValue: (v: number) => void
  pin: (on: boolean) => void
  onReset: () => void
  /** "Use size default" was pressed; Save forgets the saved value. */
  pendingReset?: boolean
  field?: FieldProps
}) {
  // What's typed while focused, so the field can be empty mid-edit without the number snapping back.
  const [text, setText] = useState<string | null>(null)
  const atDefault = pendingReset || (source === "default" && !changed)
  const sizes = boxLimitDefaults(k)
  const env = SETTING_ENV[k]
  const shown = text ?? (atDefault ? "" : String(value))
  return (
    <>
      <input
        id={id}
        type="number"
        min={1}
        max={max}
        className={cx(inputClass, atDefault && "placeholder:text-zinc-300!")}
        value={shown}
        placeholder={atDefault ? sizes : undefined}
        aria-description={atDefault ? `Each box uses its size's default: ${sizes}` : undefined}
        data-testid={`limit-${k}`}
        {...field}
        onChange={(e) => {
          const t = e.target.value
          setText(t)
          // Out of range still goes to the draft, so the field says what fits and Save waits for it.
          if (t === "") return
          onValue(Number(t))
          if (source === "default") pin(true)
        }}
        onBlur={() => {
          // An emptied field drops the edit: back to the saved value, or to the size defaults.
          if (text === "" && current !== undefined) {
            onValue(current)
            pin(false)
          }
          setText(null)
        }}
      />
      {source === "ui" && !changed && (
        <Button type="button" variant="subtle" size="sm" className="w-full sm:w-auto" onClick={onReset} data-testid={`use-size-default-${k}`}>
          Use size default
        </Button>
      )}
      {source === "env" && !changed && env && (
        <p className="text-xs leading-relaxed text-zinc-500" data-testid={`env-note-${k}`}>
          To use each box's size default ({sizes}), remove <code className="font-mono text-zinc-400">{env}</code> from .env (and from the shell or deploy env) and
          restart Box Yard.
        </p>
      )}
    </>
  )
}

/** "small 1 · medium 2 · large 4" */
export function boxLimitDefaults(k: BoxLimitKey) {
  return WORKER_SIZES.map((z) => `${z} ${SIZE_DEFAULTS[z][k]}`).join(" · ")
}

function SizeCapacityTable({ s, sources, changed }: { s: Settings; sources?: Record<keyof Settings, SettingSource>; changed: (keyof Settings)[] }) {
  const rows = sizeCapacities(s, sources, { slotsPerBox: changed.includes("slotsPerBox"), maxResidentPerBox: changed.includes("maxResidentPerBox") })
  const overridden = rows[0]!.slotsOverridden || rows[0]!.residentOverridden
  return (
    <div className="mb-4 overflow-hidden rounded-xl border border-zinc-900 text-xs" data-testid="size-capacity">
      <table className="w-full text-left tabular-nums">
        <thead className="bg-zinc-900/60 text-zinc-500">
          <tr>
            <th className="px-3 py-2 font-medium">Worker size</th>
            <th className="px-3 py-2 font-medium">Tasks running at once per box</th>
            <th className="px-3 py-2 font-medium">Task folders kept per box</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.size} className={cx("border-t border-zinc-900", r.current ? "bg-yard-500/10 text-zinc-100" : "text-zinc-400")}>
              <td className="px-3 py-2 capitalize">
                {r.size}
                {r.current && <span className="ml-2 rounded bg-yard-500/20 px-1.5 py-px text-[10px] text-yard-300 normal-case">in use</span>}
              </td>
              <td className="px-3 py-2">
                {r.slotsPerBox}
                {r.slotsOverridden && r.slotsPerBox !== r.defaults.slotsPerBox && <span className="ml-1 text-zinc-600">(size default {r.defaults.slotsPerBox})</span>}
              </td>
              <td className="px-3 py-2">
                {r.maxResidentPerBox}
                {r.residentOverridden && r.maxResidentPerBox !== r.defaults.maxResidentPerBox && (
                  <span className="ml-1 text-zinc-600">(size default {r.defaults.maxResidentPerBox})</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-zinc-900 px-3 py-2 leading-relaxed text-zinc-500">
        {overridden
          ? "Your saved or env values below replace the size defaults for every size."
          : `Each box uses its own size's values: a small box runs ${SIZE_DEFAULTS.small.slotsPerBox} task at a time and keeps ${SIZE_DEFAULTS.small.maxResidentPerBox} task folders, a medium one ${SIZE_DEFAULTS.medium.slotsPerBox} and ${SIZE_DEFAULTS.medium.maxResidentPerBox}. Set the fields below to override them for every box.`}{" "}
        Before size-based defaults, every box ran {LEGACY_POOL_DEFAULTS.slotsPerBox} tasks at once and kept {LEGACY_POOL_DEFAULTS.maxResidentPerBox} folders.
      </p>
    </div>
  )
}

/** Settings › Usage's way into the Usage modal, which used to be the spend report here. */
function OpenUsage() {
  const openUsage = useOpenUsage()
  return (
    <Button type="button" onClick={() => openUsage()} data-testid="open-usage">
      <BarChart3 className="h-4 w-4" aria-hidden />
      Open Usage
    </Button>
  )
}

function CostsPanel({
  s,
  set,
  row,
  field,
  fid,
}: {
  s: Settings
  set: <K extends keyof Settings>(k: K, v: Settings[K]) => void
  row: RowMeta
  field: FieldCheck
  fid: (k: string) => string
}) {
  const money = (path: SettingPath, value: number, onChange: (n: number) => void, id?: string) => (
    <input
      id={id}
      type="number"
      min={0}
      step={0.01}
      className={inputClass}
      value={numberText(value)}
      onChange={(e) => onChange(typedNumber(e.target.value))}
      {...field(path)}
    />
  )
  const rates = (kind: "boxActiveCpuHourlyUsd" | "boxKeepAliveMonthlyUsd") => BOX_SIZES.map((size) => `costRates.${kind}.${size}`)
  const sizeLabel: Record<BoxSize, string> = { small: "Small", medium: "Medium", large: "Large" }
  // A server older than this UI sends no cost settings and would reject saving them.
  if (!s.costRates || !s.budget)
    return (
      <Panel section="costs">
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100">
          The server is running an older build without cost settings. Rebuild and restart it to set rates and budgets.
        </div>
      </Panel>
    )
  return (
    <Panel section="costs">
      <Row
        label="Allowances, cost and tokens"
        help="Open Usage for each Claude and Codex login's session and weekly allowances, plus daily model and box costs by project and task. It opens over Settings; closing it comes back here."
      >
        <OpenUsage />
      </Row>
      <Row
        id={fid("scm")}
        label="Box spend in the header"
        help="The Coordinator's header shows the cloud meter: boxes running, what they cost an hour and today's spend against the daily limit."
        more="Off, the Boxes page still shows it, and the limit's notices and Raise today's limit work the same."
        {...row("showCloudMeter")}
      >
        <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-300">
          <input id={fid("scm")} type="checkbox" checked={Boolean(s.showCloudMeter)} onChange={(e) => set("showCloudMeter", e.target.checked)} data-testid="show-cloud-meter" />
          {s.showCloudMeter ? "On: shown in the Coordinator's header" : "Off: only on the Boxes page"}
        </label>
      </Row>
      <Row
        id={fid("daily-budget")}
        label="Daily cloud limit"
        help="What boxes may cost per day, by the CPU they use (Claude isn't counted). 0: no daily limit." more="At 80% Box Yard says so; at the limit new boxes wait until midnight while work already running goes on, and the cloud meter (on the Boxes page, and in the Coordinator's header if shown) offers Raise today's limit."
        {...row("budget", ["budget.dailyUsd"])}
      >
        {money("budget.dailyUsd", s.budget.dailyUsd, (n) => set("budget", { ...s.budget, dailyUsd: n }), fid("daily-budget"))}
      </Row>
      <Row
        id={fid("monthly-budget")}
        label="Monthly cloud limit"
        help="Box spend over the last 30 days. At it, new boxes wait until the spend drops under it or you raise it. 0: no monthly limit."
        {...row("budget", ["budget.monthlyUsd"])}
      >
        {money("budget.monthlyUsd", s.budget.monthlyUsd, (n) => set("budget", { ...s.budget, monthlyUsd: n }), fid("monthly-budget"))}
      </Row>
      <Row
        label="Active CPU rates"
        help="Upstash bills the CPU a box uses, per core-hour: a box busy on 2 cores for an hour uses 2." more="Box Yard measures each box's CPU and prices it at these rates, unless Upstash reports its own charge for the box. Defaults match the public Small / Medium / Large rates."
        {...row("costRates", rates("boxActiveCpuHourlyUsd"))}
      >
        <div className="grid grid-cols-3 gap-2">
          {BOX_SIZES.map((size) => (
            <label key={size} className="space-y-1">
              <span className="text-[11px] text-zinc-500">{sizeLabel[size]}</span>
              {money(`costRates.boxActiveCpuHourlyUsd.${size}`, s.costRates.boxActiveCpuHourlyUsd[size], (n) =>
                set("costRates", { ...s.costRates, boxActiveCpuHourlyUsd: { ...s.costRates.boxActiveCpuHourlyUsd, [size]: n } }),
              )}
            </label>
          ))}
        </div>
      </Row>
      <Row
        label="Keep-alive rates"
        help="A keep-alive box costs its monthly fee and no CPU charge, prorated by uptime, when the provider reports keep-alive is on."
        {...row("costRates", rates("boxKeepAliveMonthlyUsd"))}
      >
        <div className="grid grid-cols-3 gap-2">
          {BOX_SIZES.map((size) => (
            <label key={size} className="space-y-1">
              <span className="text-[11px] text-zinc-500">{sizeLabel[size]}</span>
              {money(`costRates.boxKeepAliveMonthlyUsd.${size}`, s.costRates.boxKeepAliveMonthlyUsd[size], (n) =>
                set("costRates", { ...s.costRates, boxKeepAliveMonthlyUsd: { ...s.costRates.boxKeepAliveMonthlyUsd, [size]: n } }),
              )}
            </label>
          ))}
        </div>
      </Row>
      <Row id={fid("storage")} label="Storage rate" help="Storage and snapshot cost per GB-month. Disk use is probed from boxes when available." {...row("costRates", ["costRates.boxStorageGbMonthUsd"])}>
        {money("costRates.boxStorageGbMonthUsd", s.costRates.boxStorageGbMonthUsd, (n) => set("costRates", { ...s.costRates, boxStorageGbMonthUsd: n }), fid("storage"))}
      </Row>
      <div className="mt-2 rounded-xl border border-zinc-900 bg-zinc-900/40 p-4 text-xs leading-relaxed text-zinc-400">
        Claude Code costs come from the CLI's result JSON and don't count against the cloud limits. A box's cost is Upstash's own charge when its API reports one, its measured CPU at these rates when that's more, and the time a turn ran (labeled an estimate) while neither is known. RunPod GPU pods, Vast.ai instances and Daytona sandboxes have their own hourly caps (<SettingsLink section="runpod">Settings › RunPod GPU</SettingsLink>, <SettingsLink section="vast">Settings › Vast.ai GPU</SettingsLink>, <SettingsLink section="daytona">Settings › Daytona</SettingsLink>); Daytona sandboxes also count toward the cloud limits, at Box Yard's estimate of their price.
      </div>
    </Panel>
  )
}

function NotificationsPanel({ fid }: { fid: (k: string) => string }) {
  // Sound on send is saved in this browser; the row previews the draft.
  const [sound, setSound] = useDraft("send-sound", "notifications", useSendSound(), setSendSound)
  return (
    <Panel section="notifications">
      <BrowserNotificationsRow fid={fid} />
      <SendSoundRow fid={fid} value={sound} onChange={setSound} />
    </Panel>
  )
}

function AboutRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <SettingsField label={label} className="grid gap-x-8 gap-y-1 border-t border-zinc-900 py-3 first:border-t-0 first:pt-0 @lg:grid-cols-[10rem_minmax(0,1fr)]">
      <dt className="text-sm text-zinc-400"><SearchHighlight text={label} /></dt>
      <dd className="min-w-0 text-sm wrap-anywhere text-zinc-100">{children}</dd>
    </SettingsField>
  )
}

function AboutPanel({ onReset, resetting }: { onReset: () => void; resetting: boolean }) {
  const health = useHealth()
  const server = useSettings()
  const h = health.data
  const link = "inline-flex items-center gap-1 text-sky-400 hover:underline"
  return (
    <Panel section="about">
      <dl>
        <AboutRow label="Version">
          <span className="font-mono">{__APP_VERSION__}</span>
          {__APP_COMMIT__ && (
            <NewTabLink className={cx(link, "ml-2 font-mono")} href={`https://github.com/AgentSystemLabs/box-yard/commit/${__APP_COMMIT__}`}>
              {__APP_COMMIT__}
            </NewTabLink>
          )}
        </AboutRow>
        <AboutRow label="Updates">
          <UpdateRow />
        </AboutRow>
        <AboutRow label="Box provider">
          {h?.provider ?? "…"}
          {h?.mock && <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-px text-[11px] text-amber-300">mock mode</span>}
        </AboutRow>
        <AboutRow label="Claude CLI">{h ? (h.claude.available ? <span className="font-mono">{h.claude.version}</span> : <span className="text-red-300">not found</span>) : "…"}</AboutRow>
        <AboutRow label="Event bus">{h ? (h.bus === "redis" ? "Upstash Redis" : "Local files") : "…"}</AboutRow>
        <AboutRow label="Scheduler">{h ? (h.scheduler === "qstash" ? "QStash + server timer" : "Server timer") : "…"}</AboutRow>
        <AboutRow label="Default time zone">{server.data?.defaultTimezone ?? "…"}</AboutRow>
        <AboutRow label="Max upload">{server.data ? `${server.data.maxUploadMb} MB` : "…"}</AboutRow>
        <AboutRow label="Links">
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <NewTabLink className={link} mark="end" href="https://github.com/AgentSystemLabs/box-yard">
              GitHub
            </NewTabLink>
            <NewTabLink className={link} mark="end" href="https://upstash.com/docs/box">
              Upstash Box docs
            </NewTabLink>
            <NewTabLink className={link} mark="end" href="https://console.upstash.com">
              Upstash console
            </NewTabLink>
          </div>
        </AboutRow>
      </dl>
      <p className="mt-6 text-xs text-zinc-500">Time zone, upload size, provider and data directory come from env vars on the server (see the README).</p>
      {/* Not a draft: it happens at once, after its own confirmation. */}
      <div className="mt-6 border-t border-zinc-900 pt-4">
        <Row label="Reset all settings" help="Forgets every value marked “saved here”, so env vars and defaults apply again. Credentials, identities, connectors, hooks and projects stay as they are.">
          <Button type="button" variant="danger" loading={resetting} onClick={onReset} data-testid="reset-settings">
            Reset all settings…
          </Button>
        </Row>
      </div>
    </Panel>
  )
}
