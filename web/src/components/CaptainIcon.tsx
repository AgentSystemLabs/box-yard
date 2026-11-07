// A Captain's icon wherever a Captain shows. shared/captainMark.ts says which: its project's pick, then the project's
// image, then Settings › Captain icon, then the Captain's cap. It draws in currentColor, so each place tints it as it
// tinted the bot before (its project's colour, mostly). The cap, the helm and the bot are in the first load; any other
// icon comes from the catalogue chunk (lib/captainIconCatalog.ts), loaded the first time one is drawn. Until then its
// place is held, empty and the same size, so no other icon flashes first.
import { memo, useEffect, useMemo, useSyncExternalStore, type HTMLAttributes } from "react"
import { Bot, createLucideIcon, type LucideIcon, type LucideProps } from "lucide-react"
import { useCaptainIconSetting } from "../lib/queries"
import { useProjectCaptainIcon, useProjectIcon } from "../lib/taskTiles"
import type { CaptainIconId } from "../../../shared/captainIcons"
import { DEFAULT_CAPTAIN_ICON, captainMark, type CaptainMark } from "../../../shared/captainMark"
import { CaptainCap, Helm } from "./ShipIcons"
import { ProjectAvatar } from "./TaskIcon"
import { cx } from "./ui"

/** In the first load: the default, the Coordinator's helm and the bot every Captain had before. */
const BUILT_IN: Partial<Record<CaptainIconId, LucideIcon>> = { "captain-cap": CaptainCap, helm: Helm, bot: Bot }

/** An icon's place while the catalogue loads: lucide's empty 24px box. */
const Pending = createLucideIcon({ name: "captain-icon-pending", node: [] })

let catalog: Record<CaptainIconId, LucideIcon> | null = null
let loading: Promise<Record<CaptainIconId, LucideIcon>> | null = null
const waiting = new Set<() => void>()

/** The catalogue's components (the picker draws them all). Every caller shares one load; a failed one is tried again next time. */
export function loadCaptainIcons(): Promise<Record<CaptainIconId, LucideIcon>> {
  loading ??= import("../lib/captainIconCatalog").then(
    (m) => {
      catalog = m.CAPTAIN_ICON_COMPONENTS
      for (const l of waiting) l()
      return catalog
    },
    (e: unknown) => {
      loading = null
      throw e
    },
  )
  return loading
}

const subscribe = (l: () => void) => {
  waiting.add(l)
  return () => void waiting.delete(l)
}
const snapshot = () => catalog

/** The catalogue once it's here; `load` starts loading it. */
export function useCaptainIconCatalog(load = true): Record<CaptainIconId, LucideIcon> | null {
  const c = useSyncExternalStore(subscribe, snapshot, snapshot)
  useEffect(() => {
    if (load && !c) loadCaptainIcons().catch(() => {})
  }, [load, c])
  return c
}

/** One icon's component: built in, from the catalogue, or its empty place while that loads. */
export function useCaptainGlyph(id: CaptainIconId): LucideIcon {
  const built = BUILT_IN[id]
  const c = useCaptainIconCatalog(!built)
  return built ?? (c ? (c[id] ?? CaptainCap) : Pending)
}

/** What a project's Captain shows now (shared/captainMark.ts); no project: Settings' icon. */
export function useCaptainMark(projectId: string | null | undefined): CaptainMark {
  const own = useProjectCaptainIcon(projectId)
  const image = useProjectIcon(projectId)
  const global = useCaptainIconSetting()
  return useMemo(() => captainMark({ captainIcon: own, iconUrl: image }, global), [own, image, global])
}

/** One icon by id, in currentColor at `className`'s size: the picker's tiles and Settings' preview. */
export function CaptainGlyph({ id, className }: { id: CaptainIconId; className?: string }) {
  const Icon = useCaptainGlyph(id)
  return <Icon data-captain-icon={id} className={className} aria-hidden />
}

/**
 * A project's Captain, as its icon or its project's image, sized and tinted by `className` (as a lucide icon would be);
 * `rounded` is the image's corners. Decorative unless given an `aria-label`. An image that doesn't load shows
 * Settings' icon instead.
 */
export const CaptainIcon = memo(function CaptainIcon({
  projectId,
  className,
  rounded = "rounded-[25%]",
  "aria-label": label,
  "aria-hidden": hidden,
  ...rest
}: { projectId: string | null | undefined; className?: string; rounded?: string } & HTMLAttributes<HTMLSpanElement>) {
  const mark = useCaptainMark(projectId)
  const global = useCaptainIconSetting()
  const Icon = useCaptainGlyph(mark.kind === "icon" ? mark.id : global || DEFAULT_CAPTAIN_ICON)
  return (
    <span
      {...rest}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={hidden ?? (label ? undefined : true)}
      data-captain-icon={mark.kind === "icon" ? mark.id : "image"}
      className={cx("inline-grid shrink-0 place-items-center", className)}
    >
      {mark.kind === "image" ? (
        <ProjectAvatar src={mark.url} className={cx("h-full w-full", rounded)}>
          <Icon className="h-full w-full" aria-hidden />
        </ProjectAvatar>
      ) : (
        <Icon className="h-full w-full" aria-hidden />
      )}
    </span>
  )
})

/**
 * A Captain's tile (the sidebar's Captain row, its card in the cards view): its project's image filling `className`'s
 * box, or its icon at `glyph`'s size on a tint of its project's colour. The caller sets `--pc` (projectColorStyle).
 */
export function CaptainTile({ projectId, className, glyph }: { projectId: string; className: string; glyph: string }) {
  const image = useCaptainMark(projectId).kind === "image"
  if (image) return <CaptainIcon projectId={projectId} className={className} rounded="rounded-md" />
  return (
    <span aria-hidden data-testid="captain-tile" className={cx("grid shrink-0 place-items-center rounded-md bg-(--pc)/15 text-(--pc)", className)}>
      <CaptainIcon projectId={projectId} className={glyph} />
    </span>
  )
}

const slots = new Map<string, LucideIcon>()

/**
 * A project's Captain icon where a component goes (an `icon` prop, as `LineIcon` and the composer's menu take): the
 * same one each time for a project, so a memo'd row doesn't re-render for it.
 */
export function captainIconFor(projectId: string | null | undefined): LucideIcon {
  const key = projectId ?? ""
  let Icon = slots.get(key)
  if (!Icon) {
    const ProjectCaptainIcon = ({ className, style, "aria-label": label, "aria-hidden": hidden, ...rest }: LucideProps) => {
      const data = Object.fromEntries(Object.entries(rest).filter(([k]) => k.startsWith("data-")))
      return <CaptainIcon {...data} projectId={projectId} className={className} style={style} aria-label={label} aria-hidden={hidden} />
    }
    Icon = ProjectCaptainIcon as unknown as LucideIcon
    slots.set(key, Icon)
  }
  return Icon
}
