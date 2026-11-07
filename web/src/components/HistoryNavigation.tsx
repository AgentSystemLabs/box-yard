import type { RefObject } from "react"
import { Button } from "./ui"
import { Loading } from "./Loading"
import { releaseListBottom, type StickyScrollHandle } from "./StickyScroll"

/** Reading-window navigation stays inside the transcript; the live composer and header keep their place. */
export function HistoryNavigation({ newer, onNewer, browsing, loading, onLatest, handle }: {
  newer: boolean; onNewer: () => void; browsing: boolean; loading: boolean; onLatest: () => void
  handle: RefObject<StickyScrollHandle | null>
}) {
  return <div aria-busy={loading || undefined}>
    {loading && <Loading kind="line" label="Loading history" />}
    {(newer || browsing) && <div className="flex flex-wrap justify-center gap-2 py-2">
      {newer && <Button variant="ghost" className="min-h-11! min-w-11! transition-none" disabled={loading} onClick={(e) => { releaseListBottom(e.currentTarget); onNewer() }}>Show newer messages</Button>}
      {browsing && <Button variant="ghost" className="min-h-11! min-w-11! transition-none" onClick={() => { onLatest(); handle.current?.scrollToEnd() }}>Return to latest</Button>}
    </div>}
  </div>
}
