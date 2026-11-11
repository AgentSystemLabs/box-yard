/**
 * Keeps the composer's row of buttons on one line at every width: the buttons that don't fit fold into its More (⋯) menu.
 *
 * To a finger, and to a mouse below 32rem, every row button is 2.75rem wide (44px, a finger's size) and they sit edge
 * to edge inside the row's 0.25rem padding, with 0.25rem between the tools at its start and Send's group at its end.
 * Send's group (Expand, Stop, Send) keeps 0.25rem between its buttons, 0.5rem while Stop is there, so a thumb doesn't
 * take one for the other. `n` buttons then need a box of 2.75n + 0.75 rem plus that group's gaps (`fitWidth`).
 * The least used fold first: the @ ! % pick buttons, then Send to (the text's ">" opens it too), then Expand, then the
 * tools (Pull requests; a task's Side question and Captain chips, one at a time from the row's end), and last Attach,
 * a phone's most used. Mic (hold to talk), Stop and Send never fold. A tool with a text label gives the label up
 * first, then folds: a 400px phone keeps "Side question" spelled out, with the Captain chip in More, rather than two
 * bare icons. Each width goes to CSS as a container query on the box (`@max-[Xrem]/composer`), never a measurement or
 * a viewport breakpoint, so a resize re-lays the row without a render. styles.css generates the classes
 * (`@source inline`), every quarter rem from 8 to 36, and `labelFrom`'s for the chips' labels.
 */

/** The groups that can fold, first to fold first. */
export const FOLD_ORDER = ["picks", "sendTo", "expand", "tools", "attach"] as const
export type FoldGroup = (typeof FOLD_ORDER)[number]

/**
 * How many row buttons each part takes (0: not there). `fixed` is what never folds: Mic, Stop, Send, and tools that
 * have no menu form. A wide button counts as more than one (the Pull requests button with its count is 1.25).
 * `tools` as a list is one count per tool, in the row's order: they then fold one at a time, the last one first.
 */
export type RowParts = Record<Exclude<FoldGroup, "tools"> | "fixed", number> & { tools: number | readonly ToolWidth[] }

/** One tool's count: a number, or for a chip with a text label, its count without the label (`slots`) and with it. */
export type ToolWidth = number | { slots: number; labelled: number }

/** A tool's count on the row once its label is gone. */
export const toolSlots = (tool: ToolWidth) => (typeof tool === "number" ? tool : tool.slots)

/**
 * Per group, the box width (rem) from which it sits on the row; below it, it's in the More menu. `more` is where the
 * More button stops showing (the first group's width). null: the group isn't there, or nothing folds.
 * `tools` is the width from which every tool is on the row, and `tool` each one's own, in the row's order.
 * `label` is, per tool, the width from which it shows its text label (null: it has none).
 */
export type FoldPlan = Record<FoldGroup | "more", number | null> & { tool: (number | null)[]; label: (number | null)[] }

const MIN = 8
const MAX = 36

/** Rounded up to a quarter rem, within the widths styles.css has classes for. */
const quarter = (rem: number) => Math.min(MAX, Math.max(MIN, Math.ceil(rem * 4) / 4))

/**
 * The narrowest box (rem, rounded up to a quarter) whose row fits `slots` buttons edge to edge, with `gaps` rem in
 * Send's group. A quarter, not a half: a 320px phone's box is 17.875rem, and a working task's six buttons need 17.75.
 */
function fitWidth(slots: number, gaps: number): number {
  return quarter(2.75 * slots + 0.75 + gaps)
}

/** What gives way at a time: a group or one tool folding into More, or one tool's label (`label`) going. */
type Step = { group: FoldGroup; slots: number; tool: number; label?: true }

/** `stop`: Stop is on the row (counted in `fixed`), which widens the gaps of Send's group. */
export function foldPlan(parts: RowParts, { stop = false }: { stop?: boolean } = {}): FoldPlan {
  const each = typeof parts.tools === "number" ? [parts.tools] : parts.tools
  const plan: FoldPlan = { picks: null, sendTo: null, expand: null, tools: null, attach: null, more: null, tool: each.map(() => null), label: each.map(() => null) }
  // First to give way first. The tools go from the row's end: each one's label, then the tool itself.
  const steps = FOLD_ORDER.flatMap((group): Step[] =>
    group === "tools"
      ? each.flatMap((w, tool): Step[] => [{ group, slots: toolSlots(w), tool }, ...(typeof w === "number" ? [] : [{ group, slots: w.labelled - w.slots, tool, label: true as const }])]).reverse()
      : [{ group, slots: parts[group], tool: 0 }],
  ).filter((s) => s.slots > 0)
  const folds = steps.filter((s) => !s.label)
  // One button gains nothing from folding alone: the More button would take its place. So the first one to fold stays
  // until the next one goes with it, and with no next one it never folds.
  const held = folds[0] && folds[0].slots <= 1 ? folds[0] : null
  const gap = stop ? 0.5 : 0.25
  const set = (step: Step, rem: number) => {
    if (step.label) plan.label[step.tool] = rem
    else if (step.group === "tools") {
      plan.tool[step.tool] = rem
      plan.tools ??= rem
    } else plan[step.group] = rem
    if (!step.label) plan.more ??= rem
  }
  steps.forEach((step, i) => {
    if (step === held) return
    // On the row with it: what never folds, this step and those after it, and More for the buttons folded before
    // (or, while that's only the held one, the button itself).
    const folded = folds.filter((f) => steps.indexOf(f) < i)
    const waiting = held !== null && folded.length === 1
    const staying = waiting ? [held, ...steps.slice(i)] : steps.slice(i)
    const slots = parts.fixed + staying.reduce((n, s) => n + s.slots, 0) + (folded.length > 0 && !waiting ? 1 : 0)
    // Send's group: a gap before Send for Stop, and one more for Expand while it's on the row.
    const rem = fitWidth(slots, gap * ((stop ? 1 : 0) + (staying.some((s) => s.group === "expand") ? 1 : 0)))
    if (held !== null && step === folds[1]) set(held, rem)
    set(step, rem)
  })
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
 * Classes for a tool's text label (the task box's "Side question" chip): shown only from `rem` (a plan's `label`);
 * below it the tool keeps just its icon (the label stays for screen readers).
 */
export function labelFrom(rem: number | null): string {
  return rem === null ? "" : `@max-[${rem}rem]/composer:sr-only`
}
