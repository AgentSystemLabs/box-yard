// What the chat knows about first-run setup without loading it (Setup.tsx, the card, is a chunk of its own that comes
// only when setup is needed): whether it is, whether it was put off in this browser, and the line that leads back to it.
import { useSetup } from "../lib/queries"
import { localFlag } from "../lib/localFlag"
import { Button, cx } from "./ui"
import type { SetupStatus } from "../../../shared/setup"

const skip = localFlag("box-yard:setup-skipped")
export const setSetupSkipped = skip.set
/** The setup card was put off in this browser: the app shows the chat with a one-line reminder instead. */
export const useSetupSkipped = skip.use

/** Setup still needs something required (never in mock mode). Undefined while loading. */
export function useSetupNeeded(): { status: SetupStatus | undefined; needed: boolean } {
  const setup = useSetup()
  return { status: setup.data, needed: Boolean(setup.data && !setup.data.ready) }
}

/** One line over the chat while setup isn't finished: what's missing, and the way back to it. */
export function SetupReminder({ status, onFinish, className }: { status: SetupStatus; onFinish: () => void; className?: string }) {
  return (
    <div className={cx("flex items-center gap-3 border-b border-amber-900/40 bg-amber-950/30 py-2 text-xs text-amber-200", className)} role="status" data-testid="setup-reminder">
      <span className="min-w-0 flex-1">Needs {status.missing.join(" and ")} before the Coordinator can work.</span>
      <Button type="button" size="sm" variant="ghost" className="shrink-0 text-amber-200 hover:text-amber-100" onClick={onFinish}>
        Finish setup
      </Button>
    </div>
  )
}
