// The Settings dialog checks what Save will send against the server's own limits (settingsPatch in server/settings.ts,
// kept in step by test/settings-validation.test.ts), so a value it would refuse gets a message next to its field
// instead of a failed Save, or a Save the browser blocks without saying where.
import type { BoxSize, Settings } from "../../../shared/types"
import { BOX_CREATE_CONCURRENCY, BOX_SIZES, CARDS_IDLE_HOURS, AUTOCOMPACT_MAX_TOKENS, AUTOCOMPACT_MIN_TOKENS, SUBTASK_MAX_CHILDREN, SUBTASK_MAX_DEPTH } from "../../../shared/types"
import { NOTE_BUDGET_LIMITS } from "../../../shared/notes"
import { LOCAL_AGENTS_LIMITS } from "../../../shared/runner"
import { isOpenAiModel } from "../../../shared/agentCli"
import { changedSections, type SettingsSection } from "./settingsNav"

/** A field: a Settings key, or a key and the value's place inside it ("budget.dailyUsd"). */
export type SettingPath = string

export interface NumberRule {
  min: number
  max: number
  whole?: boolean
}

const whole = (min: number, max: number): NumberRule => ({ min, max, whole: true })

/** The number fields, with the server's limits. */
export const NUMBER_RULES: Partial<Record<keyof Settings, NumberRule>> = {
  cardsIdleHours: { min: CARDS_IDLE_HOURS.min, max: CARDS_IDLE_HOURS.max },
  subtaskMaxDepth: whole(SUBTASK_MAX_DEPTH.min, SUBTASK_MAX_DEPTH.max),
  subtaskMaxChildren: whole(SUBTASK_MAX_CHILDREN.min, SUBTASK_MAX_CHILDREN.max),
  maxBoxes: whole(1, 100),
  boxCreateConcurrency: whole(BOX_CREATE_CONCURRENCY.min, BOX_CREATE_CONCURRENCY.max),
  slotsPerBox: whole(1, 20),
  maxAgents: whole(0, 1000),
  localAgents: whole(LOCAL_AGENTS_LIMITS.min, LOCAL_AGENTS_LIMITS.max),
  localFoldersKept: whole(0, 1000),
  localBuildCleanupIdleHours: whole(0, 24 * 365),
  localDiskMinFreeGb: whole(0, 100_000),
  maxResidentPerBox: whole(1, 200),
  boxIdleDeleteMinutes: whole(0, 30 * 24 * 60),
  workspaceRetentionDays: whole(0, 3650),
  archiveRetentionDays: whole(0, 3650),
  archiveKeepTouchedDays: whole(0, 3650),
  diskMinFreeMb: whole(0, 1_000_000),
  diskCloneFactor: { min: 1, max: 20 },
  memoryMaxUsedPercent: whole(0, 100),
  memoryMinFreeMb: whole(0, 1_000_000),
  loadMaxPerCpu: { min: 0, max: 100 },
  buildCleanupIdleMinutes: whole(0, 30 * 24 * 60),
  depCacheMaxMb: whole(100, 1_000_000),
  notesMaxCount: whole(NOTE_BUDGET_LIMITS.maxNotes.min, NOTE_BUDGET_LIMITS.maxNotes.max),
  notesMaxTokens: whole(NOTE_BUDGET_LIMITS.maxTokens.min, NOTE_BUDGET_LIMITS.maxTokens.max),
}

/** Every dollar amount in Usage (limits and rates). */
export const USD_RULE: NumberRule = { min: 0, max: 1_000_000 }

const fmt = (n: number) => n.toLocaleString("en-US")

/** "Enter a whole number from 1 to 100.", or null when `value` fits. An emptied field is NaN. */
export function numberProblem(value: number, rule: NumberRule, noun = rule.whole ? "a whole number" : "a number"): string | null {
  const fits = Number.isFinite(value) && value >= rule.min && value <= rule.max && (!rule.whole || Number.isInteger(value))
  return fits ? null : `Enter ${noun} from ${fmt(rule.min)} to ${fmt(rule.max)}.`
}

const MODEL_ID = /^[A-Za-z0-9._:\[\]/-]+$/

/** A Claude model typed into "Custom model ID". */
export function modelProblem(value: string): string | null {
  const id = value.trim()
  if (!id) return "Enter a model ID, or pick one from the list."
  if (id.length > 100) return "A model ID has at most 100 characters."
  return MODEL_ID.test(id) ? null : "Use letters, digits and . _ : / - [ ] only, no spaces."
}

export function ownerNameProblem(value: string): string | null {
  const name = value.trim()
  if (!name) return "Enter a name."
  if (name.length > 40) return "A name has at most 40 characters."
  return /^[^\n<>{}`]+$/.test(name) ? null : "A name can't have < > { } or `."
}

/**
 * What's wrong with the values Save would send, by field: `settingsPatch`'s limits, in words. Fields that aren't
 * in `patch` aren't checked, so an untouched box limit from an env var never blocks a Save.
 */
export function settingsProblems(patch: Partial<Settings>): Record<SettingPath, string> {
  const problems: Record<SettingPath, string> = {}
  const add = (path: SettingPath, problem: string | null) => {
    if (problem) problems[path] = problem
  }
  for (const [key, rule] of Object.entries(NUMBER_RULES) as [keyof Settings, NumberRule][]) {
    const value = patch[key]
    if (value !== undefined) add(key, numberProblem(value as number, rule))
  }
  if (patch.ownerName !== undefined) add("ownerName", ownerNameProblem(patch.ownerName))
  for (const key of ["orchestratorModel", "captainModel", "agentModel"] as const) if (patch[key] !== undefined) add(key, modelProblem(patch[key]))
  if (patch.orchestratorRelay) add("orchestratorRelay.model", modelProblem(patch.orchestratorRelay.model))
  // "" is "Same as its chat".
  if (patch.quickQuestionModel) add("quickQuestionModel", isOpenAiModel(patch.quickQuestionModel) ? "Quick questions run on Claude: pick a Claude model." : modelProblem(patch.quickQuestionModel))
  for (const key of ["orchestratorAutoCompact", "agentAutoCompact"] as const) {
    const v = patch[key]
    if (!v) continue
    add(
      key,
      v.unit === "percent"
        ? numberProblem(v.value, { min: 10, max: 95 }, "a percent")
        : numberProblem(v.value, { min: AUTOCOMPACT_MIN_TOKENS, max: AUTOCOMPACT_MAX_TOKENS }, "a token count"),
    )
  }
  if (patch.budget) for (const k of ["dailyUsd", "monthlyUsd"] as const) add(`budget.${k}`, numberProblem(patch.budget[k], USD_RULE, "an amount"))
  if (patch.costRates) {
    const { boxActiveCpuHourlyUsd, boxKeepAliveMonthlyUsd, boxStorageGbMonthUsd } = patch.costRates
    // Three sizes share a row, so each problem says which.
    const sized = (size: BoxSize, problem: string | null) => problem && `${size[0]!.toUpperCase()}${size.slice(1)}: ${problem}`
    for (const size of BOX_SIZES as readonly BoxSize[]) {
      add(`costRates.boxActiveCpuHourlyUsd.${size}`, sized(size, numberProblem(boxActiveCpuHourlyUsd[size], USD_RULE, "an amount")))
      add(`costRates.boxKeepAliveMonthlyUsd.${size}`, sized(size, numberProblem(boxKeepAliveMonthlyUsd[size], USD_RULE, "an amount")))
    }
    add("costRates.boxStorageGbMonthUsd", numberProblem(boxStorageGbMonthUsd, USD_RULE, "an amount"))
  }
  return problems
}

/** The sections holding a problem, for the nav's markers. */
export function problemSections(problems: Record<SettingPath, string>): Set<SettingsSection> {
  return changedSections(Object.keys(problems).map((path) => path.split(".")[0] as keyof Settings))
}

/** What a number field shows: nothing while its draft is empty (NaN), so clearing it to type anew doesn't snap to 0. */
export const numberText = (value: number) => (Number.isNaN(value) ? "" : value)

/** A number field's text as a draft value: NaN while empty, so Save asks for a number instead of saving 0. */
export const typedNumber = (text: string, wholeNumber = false) => (text.trim() === "" ? NaN : wholeNumber ? Math.trunc(Number(text)) : Number(text))

/** A value the browser would refuse (out of range, missing, unparseable). A number between the spinner's steps isn't one. */
export function refusedByBrowser(v: ValidityState): boolean {
  return v.badInput || v.customError || v.patternMismatch || v.rangeOverflow || v.rangeUnderflow || v.tooLong || v.tooShort || v.typeMismatch || v.valueMissing
}
