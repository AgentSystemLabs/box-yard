// One Save for the whole Settings dialog. Nothing in it saves on change: every control edits a draft, the
// dialog's Save writes every draft, and Discard (or closing and discarding) drops them. Plain Settings fields
// live in the dialog's own draft; every other part (voice and dictation in this browser, the TTS provider and
// keys, credentials, RunPod, hook switches, browser notifications) keeps its own with useDraft, which registers
// it here so the Save button, the "N unsaved changes" line and each section's dot see it. Two useDrafts with the
// same id (a provider's size on Box providers and on the provider's own page) edit one draft.
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react"
import type { SettingsSection } from "./settingsNav"

export interface DraftPart {
  /** The section whose nav entry gets the unsaved dot. */
  section: SettingsSection
  /** How many values differ from the saved ones (at least 1 while registered). */
  count: number
  /** Write the draft. Starts synchronously, so a permission prompt still counts as part of the Save click. */
  validate?: () => void
  save: () => Promise<void>
  discard: () => void
}

/** A Save failure whose control may be inside another section or a collapsed editor. */
export class SettingsFieldError extends Error {
  constructor(message: string, readonly section: SettingsSection, readonly controlId: string, readonly reveal?: () => void) {
    super(message)
  }
}

export interface DraftRegistry {
  update(id: string, part: DraftPart | null): void
  /** The draft every useDraft with `id` shares (draftSlots). Without it, each keeps its own. */
  slot?(id: string): DraftSlot
}

/** One draft value, shared by every mounted useDraft with its id. */
export class DraftSlot {
  private value: { value: unknown } | null = null
  private readonly listeners = new Set<() => void>()
  /** The mounted useDrafts with this id, each with a way to register its part again when another one goes. */
  readonly owners = new Map<symbol, () => void>()
  get = () => this.value
  set = (v: { value: unknown } | null) => {
    this.value = v
    for (const l of this.listeners) l()
  }
  subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => {
      this.listeners.delete(l)
    }
  }
}

/** A registry's `slot`: one DraftSlot per id, for as long as the registry lives (the Settings dialog). */
export function draftSlots(): (id: string) => DraftSlot {
  const slots = new Map<string, DraftSlot>()
  return (id) => {
    let slot = slots.get(id)
    if (!slot) slots.set(id, (slot = new DraftSlot()))
    return slot
  }
}

const noSlot = () => () => {}
const noDraft = () => null

export const SettingsDraftContext = createContext<DraftRegistry | null>(null)

/** True inside the Settings dialog, where edits wait for its Save. */
export const useInSettingsDraft = () => useContext(SettingsDraftContext) !== null

const plain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** How many values `draft` changes: differing top-level fields of an object, else 0 or 1. */
export function draftChanges(draft: unknown, saved: unknown): number {
  if (plain(draft) && plain(saved)) return [...new Set([...Object.keys(draft), ...Object.keys(saved)])].filter((k) => !same(draft[k], saved[k])).length
  return same(draft, saved) ? 0 : 1
}

/** Adds and removes parts in a record, for the dialog's state. */
export function updateParts(parts: Record<string, DraftPart>, id: string, part: DraftPart | null): Record<string, DraftPart> {
  if (part) return { ...parts, [id]: part }
  if (!(id in parts)) return parts
  const { [id]: _gone, ...rest } = parts
  return rest
}

/**
 * A value edited as a draft in the Settings dialog: `[value, set, dirty]`. `value` is the draft, or `saved` while
 * nothing differs; `persist(draft)` runs only when the dialog's Save is pressed. Changing a value back to the saved
 * one makes it clean again. Outside the dialog there's no Save, so `set` persists right away.
 */
export function useDraft<T>(
  id: string,
  section: SettingsSection,
  saved: T,
  persist: (draft: T) => unknown,
  /** How many changes the draft holds, for "N unsaved changes" (default: draftChanges). */
  countChanges: (draft: T, saved: T) => number = draftChanges,
  validate?: (draft: T) => void,
): [value: T, set: (next: T | ((prev: T) => T)) => void, dirty: boolean] {
  const registry = useContext(SettingsDraftContext)
  const slot = useMemo(() => registry?.slot?.(id) ?? null, [registry, id])
  const [own, setOwn] = useState<{ value: T } | null>(null)
  const shared = useSyncExternalStore(slot ? slot.subscribe : noSlot, slot ? slot.get : noDraft) as { value: T } | null
  const draft = slot ? shared : own
  const setDraft = useCallback((d: { value: T } | null) => (slot ? slot.set(d) : setOwn(d)), [slot])
  const value = draft ? draft.value : saved
  const count = draft ? countChanges(draft.value, saved) : 0
  const latest = useRef({ value, saved, persist, validate })
  latest.current = { value, saved, persist, validate }
  // Bumped when another useDraft with this id unmounts: this one registers the part again, with its own save.
  const [turn, registerAgain] = useReducer((n: number) => n + 1, 0)

  useEffect(() => {
    if (!registry) return
    registry.update(
      id,
      count
        ? {
            section,
            count,
            validate: () => latest.current.validate?.(latest.current.value),
            save: async () => {
              await latest.current.persist(latest.current.value)
              setDraft(null)
            },
            discard: () => setDraft(null),
          }
        : null,
    )
  }, [registry, id, section, count, turn, setDraft])
  useEffect(() => {
    if (!slot) return () => registry?.update(id, null)
    const me = Symbol(id)
    slot.owners.set(me, registerAgain)
    return () => {
      slot.owners.delete(me)
      const next = slot.owners.values().next()
      if (!next.done) return next.value()
      // The last one with this id: nothing shows the draft any more, so it goes.
      registry?.update(id, null)
      slot.set(null)
    }
  }, [registry, id, slot])

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      const cur = latest.current
      const prev = slot ? ((slot.get() as { value: T } | null)?.value ?? cur.saved) : cur.value
      const v = typeof next === "function" ? (next as (prev: T) => T)(prev) : next
      latest.current = { ...cur, value: v }
      if (registry) setDraft({ value: v })
      // Errors surface where the caller shows them (a mutation's error, a toast).
      else Promise.resolve(cur.persist(v)).catch(() => {})
    },
    [registry, slot, setDraft],
  )
  return [value, set, count > 0]
}
