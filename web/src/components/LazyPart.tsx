// Surfaces that open on demand (Settings, a project's settings, schedules) stay out of the first load: each is its own
// chunk, fetched once the app has painted and its first requests are done (useWarmLazyParts), so opening one is still
// instant. Opened before that, it shows its Loading view while the chunk comes in.
import { useEffect, useState, type ComponentType } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { whenSettled } from "../lib/captainPrefetch"
import { Button } from "./ui"

const loaders: (() => Promise<unknown>)[] = []

/**
 * `load`'s component, rendered straight away once its chunk is in, else `Loading` until it is. Not React.lazy and
 * Suspense: React.lazy suspends on its first render even when the chunk is already loaded, and React keeps a Suspense
 * fallback up for at least 300 ms, so even a warmed Settings would open slowly. If the chunk can't load (most often the
 * app was updated since this page opened, so the old chunk is gone), `Failed` renders in its place.
 */
export function lazyPart<P extends object>(
  load: () => Promise<ComponentType<P>>,
  { Loading, Failed = LoadFailed }: { Loading: ComponentType<P>; Failed?: ComponentType<P> },
): ComponentType<P> {
  let Loaded: ComponentType<P> | undefined
  let failed = false
  let pending: Promise<unknown> | undefined
  // A failed warm-up doesn't stick: opening the part tries again.
  const get = () => (pending ??= load().then((component) => (Loaded = component), (err: unknown) => {
    pending = undefined
    throw err
  }))
  loaders.push(get)
  return function LazyPart(props: P) {
    const [, setSettled] = useState(false)
    useEffect(() => {
      if (Loaded || failed) return
      let live = true
      void get()
        .catch(() => {
          failed = true
        })
        .then(() => live && setSettled(true))
      return () => {
        live = false
      }
    }, [])
    if (Loaded) return <Loaded {...props} />
    if (failed) return <Failed {...props} />
    return <Loading {...props} />
  }
}

/** Fetch every lazy part's chunk now; resolves once all are in. Failing is fine: a part then loads when it opens. */
export async function warmLazyParts() {
  await Promise.all(loaders.map((load) => load().catch(() => {})))
}

/** Mounted once (App), signed in: fetch every lazy part in the background after the first paint. */
export function useWarmLazyParts(enabled: boolean) {
  const qc = useQueryClient()
  useEffect(() => {
    if (!enabled) return
    return whenSettled(qc, warmLazyParts)
  }, [enabled, qc])
}

export function LoadFailed() {
  return (
    <div role="alert" className="space-y-3 text-sm text-zinc-300">
      <p>Couldn't load this part of the app. It may have been updated since this page opened.</p>
      <Button onClick={() => location.reload()}>Reload</Button>
    </div>
  )
}
