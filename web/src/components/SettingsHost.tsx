// Settings opens over any page from `?settings=<section>`. The dialog and its panels are a chunk of their own
// (LazyPart.tsx), so the first load doesn't ship them; open it with useOpenSettings, from here.
import type { ReactNode } from "react"
import { useSearchParams } from "wouter"
import { SETTINGS_PARAM, parseSection, type SettingsSection } from "../lib/settingsNav"
import { LoadFailed, lazyPart } from "./LazyPart"
import { Loading } from "./Loading"
import { Modal } from "./Modal"
import { withParam } from "./TaskFilters"

type DialogProps = { section: SettingsSection; onSection: (s: SettingsSection) => void; onClose: () => void }

function SettingsShell({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return <Modal size="xl" title="Settings" onClose={onClose}>{children}</Modal>
}

const SettingsDialog = lazyPart<DialogProps>(() => import("./SettingsDialog").then((m) => m.SettingsDialog), {
  Loading: ({ onClose }) => <SettingsShell onClose={onClose}><Loading label="Loading settings" /></SettingsShell>,
  Failed: ({ onClose }) => <SettingsShell onClose={onClose}><LoadFailed /></SettingsShell>,
})

/** Opens the settings dialog at a section by setting `?settings=<section>` on the current page. */
export function useOpenSettings() {
  const [, setParams] = useSearchParams()
  return (section: SettingsSection = "orchestrator") => setParams((p) => withParam(p, SETTINGS_PARAM, section), { replace: true })
}

/** Mounted once in the app: shows the dialog while the URL has `?settings=`. */
export function SettingsHost() {
  const [params, setParams] = useSearchParams()
  const value = params.get(SETTINGS_PARAM)
  if (value === null) return null
  return (
    <SettingsDialog
      section={parseSection(value)}
      onSection={(s) => setParams((p) => withParam(p, SETTINGS_PARAM, s), { replace: true })}
      onClose={() => setParams((p) => withParam(p, SETTINGS_PARAM, null), { replace: true })}
    />
  )
}
