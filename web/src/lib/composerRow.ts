/**
 * Keeps the composer's row of buttons on one line at every width: the buttons that don't fit fold into its More (⋯) menu.
 *
 * To a finger, and to a mouse below 32rem, every row button is 2.75rem wide (44px, a finger's size) and they sit edge
 * to edge inside the row's 0.25rem padding, with 0.25rem between the tools at its start and Send's group at its end.
 * Send's group (Expand, Stop, Send) keeps 0.25rem between its buttons, 0.5rem while Stop is there, so a thumb doesn't
 * take one for the other. `n` buttons then need a box of 2.75n + 0.75 rem plus that group's gaps (`fitWidth`).
 * The least used fold first: the @ ! % pick buttons, then Send to (the text's ">" opens it too), then Expand, then the
 * tools (Pull requests; a task's Side question and Captain chips), and last Attach, a phone's most used. Mic (hold to
 * talk), Stop and Send never fold. Each width goes to CSS as a container query on the box (`@max-[Xrem]/composer`),
 * never a measurement or a viewport breakpoint, so a resize re-lays the row without a render. styles.css generates the
 * classes (`@source inline`), every half rem from 8 to 36, and `labelFrom`'s for the chips' labels.
 */

/** The groups that can fold, first to fold first. */
export const FOLD_ORDER = ["picks", "sendTo", "expand", "tools", "attach"] as const
export type FoldGroup = (typeof FOLD_ORDER)[number]

/**
 * How many row buttons each part takes (0: not there). `fixed` is what never folds: Mic, Stop, Send, and tools that
 * have no menu form. A wide button counts as more than one (the Pull requests button with its count is 1.25).
 */
export type RowParts = Record<FoldGroup | "fixed", number>

/**
 * Per group, the box width (rem) from which it sits on the row; below it, it's in the More menu. `more` is where the
 * More button stops showing (the first group's width). null: the group isn't there, or nothing folds.
 */
export type FoldPlan = Record<FoldGroup | "more", number | null>

const MIN = 8
const MAX = 36

const half = (rem: number) => Math.min(MAX, Math.max(MIN, Math.ceil(rem * 2) / 2))

/**
 * The narrowest box (rem, rounded up to a half) whose row fits `slots` buttons with a 0.25rem gap after each: the
 * roomy count the task box's labelled chips are measured in (`labelFrom`). The fold widths are tighter (`fitWidth`).
 */
export function rowWidth(slots: number): number {
  return half(3 * slots + 0.5)
}

/** The narrowest box (rem, rounded up to a half) whose row fits `slots` buttons edge to edge, with `gaps` rem in Send's group. */
function fitWidth(slots: number, gaps: number): number {
  return half(2.75 * slots + 0.75 + gaps)
}

/** `stop`: Stop is on the row (counted in `fixed`), which widens the gaps of Send's group. */
export function foldPlan(parts: RowParts, { stop = false }: { stop?: boolean } = {}): FoldPlan {
  const plan: FoldPlan = { picks: null, sendTo: null, expand: null, tools: null, attach: null, more: null }
  const there = FOLD_ORDER.filter((g) => parts[g] > 0)
  const first = there[0]
  // One button alone gains nothing from folding: the More button would take its place.
  if (first === undefined || (there.length === 1 && parts[first] <= 1)) return plan
  const gap = stop ? 0.5 : 0.25
  there.forEach((g, i) => {
    const staying = there.slice(i)
    // On the row with it: what never folds, this group and those that fold after it, and More for the ones before.
    const slots = parts.fixed + staying.reduce((n, h) => n + parts[h], 0) + (i > 0 ? 1 : 0)
    // Send's group: a gap before Send for Stop, and one more for Expand while it's on the row.
    plan[g] = fitWidth(slots, gap * ((stop ? 1 : 0) + (staying.includes("expand") ? 1 : 0)))
  })
  plan.more = plan[first]
  return plan
}

/** Classes for a group's buttons on the row: gone below its width. */
export function onRow(rem: number | null): string {
  return rem === null ? "" : `@max-[${rem}rem]/composer:hidden`
}

/** Classes for a group's line in the More menu (and the More button itself): only below its width. */
export function inMenu(rem: number | null): string {
  return rem === null ? "hidden" : `@min-[${rem}rem]/composer:hidden`
}

/**
 * Classes for a tool's text label (the task box's "Side question" chip): shown only from `rem`, where the row fits the
 * labelled tools; below it the tool keeps just its icon (the label stays for screen readers).
 */
export function labelFrom(rem: number): string {
  return `@max-[${rem}rem]/composer:sr-only`
}
