import { useMemo } from "react"
import { cursorModelVendor, type CursorModel } from "../../../shared/agentCli"
import { useCursorModels, useRefreshCursorModels } from "../lib/queries"
import { timeAgo } from "../lib/time"
import { Loading } from "./Loading"
import { Select } from "./ui"

const VENDOR_ORDER = ["Cursor", "Anthropic", "OpenAI", "Google", "xAI", "Other"]

/** Cursor's models by family, in the CLI's own order within each. */
function grouped(models: CursorModel[]): [string, CursorModel[]][] {
  const by = new Map<string, CursorModel[]>()
  for (const m of models) {
    const v = cursorModelVendor(m.id)
    by.set(v, [...(by.get(v) ?? []), m])
  }
  return VENDOR_ORDER.filter((v) => by.has(v)).map((v) => [v, by.get(v)!])
}

/**
 * Cursor's models as the server's `cursor-agent models` lists them for this account (server/cursor.ts), grouped by
 * family, with where the list came from and a Refresh. A saved id the list doesn't have stays selectable. `compact`
 * (the new-task dialog) leaves the source line out, and `defaultLabel` names the "" choice.
 */
export function CursorModelSelect({
  id,
  value,
  onChange,
  testId,
  compact = false,
  defaultLabel = "Cursor CLI default",
}: {
  id: string
  value: string
  onChange: (v: string) => void
  testId: string
  compact?: boolean
  defaultLabel?: string
}) {
  const q = useCursorModels()
  const refresh = useRefreshCursorModels()
  const list = refresh.data ?? q.data
  const groups = useMemo(() => grouped(list?.models ?? []), [list])
  if (!list) return q.isError ? <p className="text-xs text-red-300">Couldn't load Cursor's models: {(q.error as Error).message}</p> : <Loading kind="field" label="Loading Cursor's models" />
  const unlisted = value !== "" && !list.models.some((m) => m.id === value)
  const source =
    list.source === "cli"
      ? `Listed by cursor-agent on the server ${list.fetchedAt ? timeAgo(list.fetchedAt) : ""}`.trim()
      : list.source === "cache"
        ? `cursor-agent couldn't list them just now (${list.error ?? "unknown error"}), so this is its list from ${list.fetchedAt ? timeAgo(list.fetchedAt) : "earlier"}`
        : `cursor-agent couldn't list them here (${list.error ?? "unknown error"}), so this is Box Yard's snapshot from Nov 2026`
  return (
    <div className="min-w-0 space-y-1.5">
      <Select id={id} className="w-full" value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId} aria-describedby={compact ? undefined : `${id}-source`}>
        <option value="">{defaultLabel}</option>
        {unlisted && <option value={value}>{value} (saved, not in Cursor's list)</option>}
        {groups.map(([vendor, models]) => (
          <optgroup key={vendor} label={vendor}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} · {m.id}
              </option>
            ))}
          </optgroup>
        ))}
      </Select>
      {!compact && (
        <p id={`${id}-source`} className="flex flex-wrap items-center gap-x-2 text-xs leading-relaxed text-zinc-500" data-testid={`${testId}-source`}>
          <span className={list.source === "cli" ? undefined : "text-amber-300"}>
            {source} · {list.models.length} models. The id carries the effort (…-high, …-max).
          </span>
          <button type="button" className="text-yard-300 hover:text-yard-200 disabled:opacity-50" disabled={refresh.isPending} onClick={() => refresh.mutate()} data-testid={`${testId}-refresh`}>
            {refresh.isPending ? "Refreshing…" : "Refresh"}
          </button>
        </p>
      )}
    </div>
  )
}
