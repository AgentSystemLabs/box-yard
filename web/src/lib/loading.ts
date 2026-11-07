// Loading states wait before they show: a response quicker than this never flashes one (components/Loading.tsx).
import { useEffect, useState } from "react"

/** How long something may load before a loading state shows. */
export const LOADING_DELAY_MS = 300

/** True once `active` has stayed true for `ms`, and false again the moment it turns false. */
export function useDelayedFlag(active: boolean, ms = LOADING_DELAY_MS): boolean {
  const [late, setLate] = useState(false)
  useEffect(() => {
    if (!active) {
      setLate(false)
      return
    }
    const timer = setTimeout(() => setLate(true), ms)
    return () => clearTimeout(timer)
  }, [active, ms])
  return active && late
}
