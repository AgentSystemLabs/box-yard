// Task-specific machine sizes. Reuse the providers' own tables for menus, validation and placement.
import { BOX_SIZE_ORDER } from "./boxSizes.js"
import { DAYTONA_SIZES, type DaytonaSize } from "./daytona.js"
import type { BoxSize } from "./types.js"

export const isBoxSize = (v: unknown): v is BoxSize => BOX_SIZE_ORDER.includes(v as BoxSize)

export const DAYTONA_SIZE_ALIASES: Readonly<Record<string, string>> = { small: "cpu-small", medium: "cpu-standard", large: "cpu-large" }

/** Friendly CPU aliases, alongside Daytona's existing Settings size keys. */
export function daytonaSize(key: string): DaytonaSize | null {
  const k = key.toLowerCase()
  const cpu = DAYTONA_SIZE_ALIASES[k]
  return DAYTONA_SIZES.find((s) => s.key.toLowerCase() === (cpu ?? k)) ?? null
}
