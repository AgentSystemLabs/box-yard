// A project's settings open over whatever the app shows (ProjectSettingsHost in App.tsx reads `?projectSettings=<id>`):
// the Captain's ⋯, a sidebar project row and Settings › Projects all open the same dialog.
import { useSearchParams } from "wouter"

export const PROJECT_SETTINGS_PARAM = "projectSettings"

/** Open a project's settings without leaving the current chat or panel. */
export function useOpenProjectSettings() {
  const [, setParams] = useSearchParams()
  return (id: string) =>
    setParams((p) => {
      p.set(PROJECT_SETTINGS_PARAM, id)
      return p
    }, { replace: true })
}
