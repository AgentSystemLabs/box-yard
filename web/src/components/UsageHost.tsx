// Usage opens over any page from `?usage=<days>` (the sidebar's Usage button, Settings › Usage). The modal and its
// charts are a chunk of their own (LazyPart.tsx), so the first load doesn't ship them.
import { useSearchParams } from "wouter"
import { useQueryClient } from "@tanstack/react-query"
import { USAGE_RANGES, type UsageRangeDays } from "../../../shared/usageLedger"
import { prefetchUsageLedger } from "../lib/queries"
import { localDayStarts } from "../lib/usageChart"
import { LoadFailed, lazyPart } from "./LazyPart"
import { Loading } from "./Loading"
import { Modal } from "./Modal"
import { withParam } from "./TaskFilters"

export const USAGE_PARAM = "usage"

type ModalProps = { days: UsageRangeDays; onDays: (d: UsageRangeDays) => void; onClose: () => void }

const UsageModal = lazyPart<ModalProps>(() => import("./UsageModal").then((m) => m.UsageModal), {
  Loading: ({ onClose }) => (
    <Modal size="wide" title="Usage" onClose={onClose}>
      <Loading label="Loading usage" />
    </Modal>
  ),
  Failed: ({ onClose }) => (
    <Modal size="wide" title="Usage" onClose={onClose}>
      <LoadFailed />
    </Modal>
  ),
})

const parseDays = (v: string | null): UsageRangeDays => USAGE_RANGES.find((d) => String(d) === v) ?? 30

/** Opens Usage at a range (default 30 days) by setting `?usage=<days>` on the current page. */
export function useOpenUsage() {
  const [, setParams] = useSearchParams()
  return (days: UsageRangeDays = 30) => setParams((p) => withParam(p, USAGE_PARAM, String(days)), { replace: true })
}

/** Starts fetching a range's numbers before Usage opens (a pointer on its button, a finger pressing it, focus). */
export function usePrefetchUsage() {
  const qc = useQueryClient()
  return (days: UsageRangeDays = 30) => void prefetchUsageLedger(qc, localDayStarts(days, Date.now()))
}

/** Mounted once in the app: shows Usage while the URL has `?usage=`. */
export function UsageHost() {
  const [params, setParams] = useSearchParams()
  const value = params.get(USAGE_PARAM)
  if (value === null) return null
  return (
    <UsageModal
      days={parseDays(value)}
      onDays={(d) => setParams((p) => withParam(p, USAGE_PARAM, String(d)), { replace: true })}
      onClose={() => setParams((p) => withParam(p, USAGE_PARAM, null), { replace: true })}
    />
  )
}
