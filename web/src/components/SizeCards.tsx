// A provider's sizes as a grid of cards (Settings › Box providers): Upstash box sizes, Docker containers, Daytona
// sandboxes. Each card says what the size gets and, where the provider bills for it, what it costs.
import { Check } from "lucide-react"
import { cx } from "./ui"
import { BOX_SIZE_SPECS, sizePriceLine, sizeSpecLine } from "../../../shared/boxSizes"
import { SIZE_DEFAULTS, WORKER_SIZES, type WorkerSize } from "../../../shared/types"

export interface SizeOption {
  key: string
  title: string
  /** "4 vCPU · 8 GB RAM · 20 GB disk" */
  spec: string
  price?: string | null
  /** A heading the card goes under ("CPU only", "With a GPU"): cards with the same group in a row share one. */
  group?: string
}

/** One card per size; `value` null picks none. The cards are radios: picking one is a draft like any setting. */
export function SizeCards({ label, options, value, onPick, name }: { label: string; options: SizeOption[]; value: string | null; onPick: (key: string) => void; name: string }) {
  const groups: { group?: string; options: SizeOption[] }[] = []
  for (const o of options) {
    const last = groups.at(-1)
    if (last && last.group === o.group) last.options.push(o)
    else groups.push({ group: o.group, options: [o] })
  }
  return (
    <div role="radiogroup" aria-label={label} className="@container space-y-3">
      {groups.map((g, i) => (
        <div key={g.group ?? i} className="space-y-1.5">
          {g.group && <p className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">{g.group}</p>}
          <div className="grid gap-2 @sm:grid-cols-2 @2xl:grid-cols-3">
            {g.options.map((o) => {
              const on = o.key === value
              return (
                <button
                  key={o.key}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  data-size={`${name}:${o.key}`}
                  onClick={() => onPick(o.key)}
                  className={cx(
                    "flex min-h-11 flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition focus-visible:ring-2 focus-visible:ring-yard-400 focus-visible:outline-none",
                    on ? "border-yard-500/60 bg-yard-500/10" : "border-zinc-800 bg-zinc-900 hover:border-zinc-700",
                  )}
                >
                  <span className="flex w-full items-center gap-1.5 text-sm font-medium text-zinc-100">
                    <span className="min-w-0 flex-1">{o.title}</span>
                    {on && <Check className="h-3.5 w-3.5 shrink-0 text-yard-300" aria-hidden="true" />}
                  </span>
                  <span className="text-xs text-zinc-400">{o.spec}</span>
                  {o.price && <span className="text-[11px] text-zinc-500 tabular-nums">{o.price}</span>}
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

/** Upstash box sizes (Settings.workerSize, a plain field of the dialog's draft), from BOX_SIZE_SPECS. */
export function UpstashSizes({ value, onPick }: { value: WorkerSize; onPick: (size: WorkerSize) => void }) {
  return (
    <SizeCards
      name="upstash"
      label="Upstash box size"
      value={value}
      onPick={(key) => onPick(key as WorkerSize)}
      options={WORKER_SIZES.map((z) => ({
        key: z,
        title: BOX_SIZE_SPECS[z].label,
        spec: `${sizeSpecLine(z)} · ${SIZE_DEFAULTS[z].slotsPerBox} ${SIZE_DEFAULTS[z].slotsPerBox === 1 ? "task" : "tasks"} at once`,
        price: sizePriceLine(z),
      }))}
    />
  )
}
