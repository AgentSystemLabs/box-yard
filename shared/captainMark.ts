// Which icon a Captain shows, without the catalogue (captainIcons.ts): the first screen draws Captains with this, and the
// catalogue's labels and search words load with the picker.
import type { CaptainIconId } from "./captainIcons.js"

/** Every Captain's icon until Settings or the project picks another. */
export const DEFAULT_CAPTAIN_ICON = "captain-cap" satisfies CaptainIconId

/**
 * What a project's Captain shows, and why: the project's own pick wins; with none (its "Use default"), the project's
 * uploaded image, then Settings' icon for every Captain, then the Captain's cap. `global` is Settings' captainIcon.
 * The ids were checked where they were read (Store.getProject, SettingsStore), so this doesn't look them up.
 */
export type CaptainMark =
  | { kind: "icon"; id: CaptainIconId; from: "project" | "settings" }
  | { kind: "image"; url: string }

export function captainMark(project: { captainIcon?: CaptainIconId | null; iconUrl?: string | null } | null | undefined, global: CaptainIconId | null | undefined): CaptainMark {
  if (project?.captainIcon) return { kind: "icon", id: project.captainIcon, from: "project" }
  if (project?.iconUrl) return { kind: "image", url: project.iconUrl }
  return { kind: "icon", id: global || DEFAULT_CAPTAIN_ICON, from: "settings" }
}
