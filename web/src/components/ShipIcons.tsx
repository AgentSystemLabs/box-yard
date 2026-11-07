// Box Yard's own two icons, drawn for it on lucide's 24px grid (2px stroke, round caps and joins, currentColor), so
// they sit with lucide's: the Captain's cap every Captain shows by default, and the helm the Coordinator steers by.
// Their own module, so the chat icons, a Captain's icon (CaptainIcon.tsx) and the catalogue all take them without a
// cycle.
import { createLucideIcon } from "lucide-react"

/**
 * A Captain: a captain's peaked cap on lucide's 24px grid (#10 of the Captain icon sheet): the crown, the band, a filled
 * peak and a filled badge. The default for every Captain (shared/captainIcons.ts), in its project's colour.
 */
export const CaptainCap = createLucideIcon({
  name: "captain-cap",
  node: [
    ["path", { d: "M6 13 2.8 9.4C2.2 7.2 6.6 5.2 12 5.2s9.8 2 9.2 4.2L18 13Z", key: "crown" }],
    ["path", { d: "M6 13h12v2.8H6Z", key: "band" }],
    ["path", { d: "M6 15.8h12c-1 2.8-11 2.8-12 0Z", fill: "currentColor", stroke: "none", key: "peak" }],
    ["circle", { cx: "12", cy: "9.2", r: "1.4", fill: "currentColor", stroke: "none", key: "badge" }],
  ],
})

/**
 * The Coordinator: a ship's six-spoke helm on lucide's 24px grid (#2 of the Captain icon sheet): the rim, six spokes
 * through it and a filled hub. It steers the work across every project, so it's the yard's, in yellow.
 */
export const Helm = createLucideIcon({
  name: "helm",
  node: [
    ["circle", { cx: "12", cy: "12", r: "6.6", key: "rim" }],
    ["path", { d: "M12 12L12 1.6M12 12L21.01 6.8M12 12L21.01 17.2M12 12L12 22.4M12 12L2.99 17.2M12 12L2.99 6.8", key: "spokes" }],
    ["circle", { cx: "12", cy: "12", r: "2.4", fill: "currentColor", stroke: "none", key: "hub" }],
  ],
})
