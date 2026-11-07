import { NEXT_STEPS_META_KEY } from "../../../shared/nextSteps"
import { TAP_AREA, cx } from "./ui"

export function nextStepsFromMeta(meta: Record<string, unknown> | null | undefined): string[] {
  const value = meta?.[NEXT_STEPS_META_KEY]
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, 4) : []
}

/** A reply's next steps, as quiet chips. */
export function RecommendedNextSteps({
  steps,
  onPick,
  className,
}: {
  steps: string[]
  onPick: (step: string) => void
  className?: string
}) {
  if (!steps.length) return null
  return (
    // Drawn small so a stack of them stays calm; TAP_AREA stretches each to 44px under a finger, and the row gap
    // under a finger is wide enough that those stretched areas don't overlap.
    <div role="group" className={cx("mt-2 flex flex-wrap gap-1.5 pointer-coarse:gap-y-4 pointer-coarse:py-1", className)} aria-label="Recommended next steps">
      {steps.map((step) => (
        <button
          key={step}
          type="button"
          onClick={() => onPick(step)}
          className={cx(
            TAP_AREA,
            "inline-flex min-h-7 max-w-full items-center rounded-full border border-zinc-800 bg-zinc-900/70 px-2.5 py-1 text-left text-xs wrap-anywhere text-zinc-300 transition hover:border-yard-500/50 hover:bg-yard-500/10 hover:text-yard-100 focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none motion-reduce:transition-none",
          )}
        >
          {step}
        </button>
      ))}
    </div>
  )
}
