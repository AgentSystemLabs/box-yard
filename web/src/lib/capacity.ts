// Pure helpers for per-box capacity: what each worker size gives you.
import { SIZE_DEFAULTS, WORKER_SIZES, type SettingSource, type WorkerSize } from "../../../shared/types"

/** Pool defaults before they became size-based: every box ran 2 tasks at once and kept 12 task folders. */
export const LEGACY_POOL_DEFAULTS = { slotsPerBox: 2, maxResidentPerBox: 12 } as const

export interface SizeCapacity {
  size: WorkerSize
  /** Tasks running at once per box that would apply with this size. */
  slotsPerBox: number
  maxResidentPerBox: number
  /** The size's own defaults (SIZE_DEFAULTS). */
  defaults: { slotsPerBox: number; maxResidentPerBox: number }
  /** True when a saved or env value replaces the size default. */
  slotsOverridden: boolean
  residentOverridden: boolean
  current: boolean
}

export interface CapacityInput {
  workerSize: WorkerSize
  slotsPerBox: number
  maxResidentPerBox: number
}

/**
 * Effective slots and resident limit for each worker size. A value is "overridden" when it was
 * saved in Settings or set by env (or edited in the form); otherwise the size default applies.
 */
export function sizeCapacities(
  s: CapacityInput,
  sources: Partial<Record<"slotsPerBox" | "maxResidentPerBox", SettingSource>> = {},
  edited: { slotsPerBox?: boolean; maxResidentPerBox?: boolean } = {},
): SizeCapacity[] {
  const slotsOverridden = Boolean(edited.slotsPerBox) || (sources.slotsPerBox !== undefined && sources.slotsPerBox !== "default")
  const residentOverridden = Boolean(edited.maxResidentPerBox) || (sources.maxResidentPerBox !== undefined && sources.maxResidentPerBox !== "default")
  return WORKER_SIZES.map((size) => {
    const defaults = SIZE_DEFAULTS[size]
    return {
      size,
      slotsPerBox: slotsOverridden ? s.slotsPerBox : defaults.slotsPerBox,
      maxResidentPerBox: residentOverridden ? s.maxResidentPerBox : defaults.maxResidentPerBox,
      defaults,
      slotsOverridden,
      residentOverridden,
      current: size === s.workerSize,
    }
  })
}
