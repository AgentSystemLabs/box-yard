import { useId } from "react"
import { setTheme, useTheme, type ThemePreference } from "../lib/theme"
import { useDraft } from "../lib/settingsDraft"
import { Panel, Row } from "./SettingsBlocks"
import { Select } from "./ui"

export function AppearancePanel() {
  const id = useId()
  const saved = useTheme()
  const [theme, set] = useDraft("theme", "appearance", saved, setTheme)
  return (
    <Panel section="appearance">
      <Row id={id} label="Theme" help="Light or dark colors across the app. System follows your device's appearance, including changes while the app is open. Save applies your choice and remembers it in this browser.">
        <Select id={id} value={theme} onChange={(e) => set(e.target.value as ThemePreference)} className="w-full">
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </Select>
      </Row>
    </Panel>
  )
}
