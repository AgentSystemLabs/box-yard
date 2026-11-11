// A task's tile (its icon in its project's colour, shared/taskIcons.ts and shared/projectColors.ts), a project's
// dot, and a project's own icon (shared/projectIcons.ts) where it has one. The same tile marks a task in a chat link,
// an update chip, a "from:" line and the project bar, so a task reads the same wherever it shows up. In the sidebar and
// a task's header the tile also says the task's state (TaskStatusIcon): it pulses while the task works, and a still
// dot in its corner says it is working, asks Cody or failed.
import { memo, useState, type CSSProperties, type ReactNode } from "react"
import {
  Anchor,
  AudioLines,
  Bell,
  BookOpen,
  Boxes,
  Bug,
  CalendarClock,
  Camera,
  ChartLine,
  CircleDollarSign,
  Cloud,
  Code,
  Cpu,
  Database,
  Diamond,
  Droplet,
  Dumbbell,
  Film,
  Flame,
  FlaskConical,
  Gamepad2,
  Gauge,
  GitPullRequest,
  Globe,
  Hammer,
  HeartPulse,
  Hexagon,
  Image as ImageIcon,
  KeyRound,
  Layers,
  Leaf,
  Lightbulb,
  Link as LinkIcon,
  ListChecks,
  Lock,
  Mail,
  Map as MapIcon,
  MessageSquare,
  Moon,
  Mountain,
  Package,
  Palette,
  PanelRight,
  PenLine,
  Plug,
  Radio,
  Rocket,
  Route,
  Server,
  Settings,
  Shield,
  Smartphone,
  Sparkles,
  Star,
  Telescope,
  Tent,
  Terminal,
  ToggleRight,
  Triangle,
  Users,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react"
import { useProjectColor, useProjectIcon, useTaskTile } from "../lib/taskTiles"
import { PROJECT_COLOR_HEX, type ProjectColor } from "../../../shared/projectColors"
import { taskIcon, type TaskIconName } from "../../../shared/taskIcons"
import type { CaptainState, Task, TaskStatus } from "../../../shared/types"

// Not ui.tsx's cx: ui.tsx draws task links with TaskTile, so importing it here would be a cycle.
const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ")

export const TASK_ICON_COMPONENTS: Record<TaskIconName, LucideIcon> = {
  bug: Bug,
  wrench: Wrench,
  hammer: Hammer,
  "flask-conical": FlaskConical,
  "book-open": BookOpen,
  "pen-line": PenLine,
  palette: Palette,
  layers: Layers,
  "panel-right": PanelRight,
  camera: Camera,
  image: ImageIcon,
  film: Film,
  "audio-lines": AudioLines,
  map: MapIcon,
  "gamepad-2": Gamepad2,
  rocket: Rocket,
  cloud: Cloud,
  server: Server,
  database: Database,
  cpu: Cpu,
  gauge: Gauge,
  "chart-line": ChartLine,
  "circle-dollar-sign": CircleDollarSign,
  telescope: Telescope,
  lightbulb: Lightbulb,
  shield: Shield,
  lock: Lock,
  "key-round": KeyRound,
  plug: Plug,
  link: LinkIcon,
  "git-pull-request": GitPullRequest,
  terminal: Terminal,
  code: Code,
  package: Package,
  boxes: Boxes,
  settings: Settings,
  "toggle-right": ToggleRight,
  bell: Bell,
  mail: Mail,
  "message-square": MessageSquare,
  "calendar-clock": CalendarClock,
  smartphone: Smartphone,
  globe: Globe,
  users: Users,
  "heart-pulse": HeartPulse,
  dumbbell: Dumbbell,
  sparkles: Sparkles,
  "list-checks": ListChecks,
  moon: Moon,
  star: Star,
  hexagon: Hexagon,
  leaf: Leaf,
  diamond: Diamond,
  triangle: Triangle,
  droplet: Droplet,
  flame: Flame,
  zap: Zap,
  anchor: Anchor,
  mountain: Mountain,
  tent: Tent,
  route: Route,
  radio: Radio,
}

/** `--pc`: the project colour that tiles, dots and edges draw with (`text-(--pc)`, `bg-(--pc)/15`). */
export const projectColorStyle = (color: ProjectColor | null | undefined): CSSProperties | undefined =>
  color ? ({ "--pc": PROJECT_COLOR_HEX[color] } as CSSProperties) : undefined

/** A resting tile's neutral colour, in place of its project's. */
const MUTED = { "--pc": "#a1a1aa" } as CSSProperties

const TILE_SIZE = {
  sm: "h-4 w-4 rounded-[4px] [&>svg]:h-[11px] [&>svg]:w-[11px]",
  md: "h-5 w-5 rounded-[5px] [&>svg]:h-3 [&>svg]:w-3",
  lg: "h-[22px] w-[22px] rounded-md [&>svg]:h-[13px] [&>svg]:w-[13px]",
} as const

/**
 * A task's tile: its icon in its project's colour, on a tint of it (`bare`: no tint, for inside a link's text).
 * `muted` gives a resting card a neutral tile without changing its project's identity.
 * Nothing for a task the app doesn't know. Decorative: the text beside it names the task.
 */
export const TaskTile = memo(function TaskTile({ id, size = "sm", bare = false, muted = false, className }: { id: string | null | undefined; size?: "sm" | "lg"; bare?: boolean; muted?: boolean; className?: string }) {
  const tile = useTaskTile(id)
  if (!tile) return null
  const Icon = TASK_ICON_COMPONENTS[tile.icon]
  return (
    <span
      aria-hidden
      data-testid="task-tile"
      data-icon={tile.icon}
      data-color={tile.color}
      title={`${tile.title}${tile.projectName ? ` · ${tile.projectName}` : ""}`}
      style={muted ? MUTED : projectColorStyle(tile.color)}
      className={cx("inline-grid shrink-0 place-items-center text-(--pc)", bare ? "[&>svg]:h-[11px] [&>svg]:w-[11px]" : cx(TILE_SIZE[size], "bg-(--pc)/15"), className)}
    >
      <Icon />
    </span>
  )
})

/** A still corner dot, with the working icon's pulse as an additional cue. */
export type IconCue = "working" | "asks" | "failed" | null
type ManagerIconState = Partial<Pick<CaptainState, "busy" | "compacting" | "error">> | null | undefined

export function iconCue(status: TaskStatus): IconCue {
  if (status === "working" || status === "starting") return "working"
  if (status === "needs_input") return "asks"
  if (status === "failed") return "failed"
  return null
}

/** Managers have no needs-input state. Never infer one from their tasks, queued work or chat text. */
export function agentIconCue(state: ManagerIconState): IconCue {
  if (state?.error) return "failed"
  if (state?.busy || state?.compacting) return "working"
  return null
}

export function agentIconLabel(state: ManagerIconState): string | undefined {
  return state?.error ? "Error" : state?.compacting ? "Compacting…" : state?.busy ? "Working…" : undefined
}

/**
 * The one animation (Cody's): an icon at work (a task's, a Captain's, the Coordinator's) fades gently out and back,
 * Tailwind's pulse, every 2s. Never under prefers-reduced-motion. CueDot stays still and opaque in either mode.
 */
export const WORKING_PULSE = "motion-safe:animate-pulse"

/**
 * A cue's fill. The light theme remaps the palette to inks dark enough for text (styles.css), which would draw these
 * brown, maroon and navy, so there each takes a literal amber, red and sky; the dark theme keeps the palette's.
 */
export const CUE_DOT: Record<NonNullable<IconCue>, string> = {
  asks: "bg-[#d97706] dark:bg-amber-400",
  failed: "bg-[#dc2626] dark:bg-red-500",
  working: "bg-[#0284c7] dark:bg-sky-400",
}

/**
 * The still dot at an icon's bottom right corner (its box is `relative`): amber when it asks Cody, red when it failed
 * (or a manager errored), and sky while it works. The themed surface ring separates it from any project icon/image.
 */
export function CueDot({ cue }: { cue: IconCue }) {
  if (!cue) return null
  return <span aria-hidden data-cue={cue} className={cx("absolute -right-0.5 -bottom-0.5 h-2 w-2 rounded-full ring-2 ring-zinc-950", CUE_DOT[cue])} />
}

/**
 * A task's tile that says its state (the sidebar's rows, a task's header): its glyph pulses while
 * the task works (WORKING_PULSE) and it wears a still CueDot. Drawn from the task itself, so it
 * shows before the tile store has it. `label` overrides the active cue's accessible name/tooltip; a resting icon
 * without a label is decorative. `muted`: a resting row's neutral tile.
 */
export const TaskStatusIcon = memo(function TaskStatusIcon({ task, size = "md", muted = false, label, className }: {
  task: Pick<Task, "id" | "title" | "icon" | "projectId" | "status">
  size?: keyof typeof TILE_SIZE
  muted?: boolean
  label?: string
  className?: string
}) {
  const color = useProjectColor(task.projectId)
  const icon = taskIcon(task)
  const Icon = TASK_ICON_COMPONENTS[icon]
  const cue = iconCue(task.status)
  const stateLabel = label ?? (cue === "working" ? "Working" : cue === "asks" ? "Needs you" : cue === "failed" ? "Failed" : undefined)
  return (
    <span
      role={stateLabel ? "img" : undefined}
      aria-label={stateLabel}
      aria-hidden={stateLabel ? undefined : true}
      title={stateLabel}
      data-testid="task-status-icon"
      data-status={task.status}
      data-icon={icon}
      style={muted || !color ? MUTED : projectColorStyle(color)}
      className={cx("relative inline-grid shrink-0 place-items-center bg-(--pc)/15 text-(--pc)", TILE_SIZE[size], className)}
    >
      <Icon aria-hidden className={cue === "working" ? WORKING_PULSE : undefined} />
      <CueDot cue={cue} />
    </span>
  )
})

/** Icons that didn't load this session: every other place that draws one goes straight to its fallback. */
const brokenIcons = new Set<string>()

/**
 * A project's own icon (Project.iconUrl) in place of its mark: `children`, its coloured letter, tile or dot. The image
 * takes `className`'s box (give it the size and rounding the mark has), cropped to fill it. No icon, or one that
 * doesn't load, draws `children`. Decorative: the text beside it names the project.
 */
export const ProjectAvatar = memo(function ProjectAvatar({ src, className, children }: { src: string | null | undefined; className?: string; children?: ReactNode }) {
  const [, setBroken] = useState<string | null>(null)
  if (!src || brokenIcons.has(src)) return children
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      draggable={false}
      decoding="async"
      data-testid="project-icon"
      onError={() => {
        brokenIcons.add(src)
        setBroken(src)
      }}
      className={cx("shrink-0 object-cover", className)}
    />
  )
})

/** A project's dot, in its colour; its own icon, a little larger, when it has one. */
export const ProjectDot = memo(function ProjectDot({ projectId, className }: { projectId: string | null | undefined; className?: string }) {
  const color = useProjectColor(projectId)
  const icon = useProjectIcon(projectId)
  if (!color) return null
  return (
    <ProjectAvatar src={icon} className={cx("inline-block h-3.5 w-3.5 rounded-[3px] align-middle", className)}>
      <span aria-hidden data-testid="project-dot" data-color={color} style={projectColorStyle(color)} className={cx("inline-block h-2 w-2 shrink-0 rounded-full bg-(--pc)", className)} />
    </ProjectAvatar>
  )
})
