// The file preview modal: images in a lightbox, markdown rendered, HTML and PDF in iframes, text and code with line
// numbers (JSON pretty-printed, CSV as a table), video and audio in native players. Mounted once as <FilePreviewHost>;
// links open it through <FileLink> and lib/preview.ts.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react"
import { useSearchParams } from "wouter"
import { Check, ChevronLeft, ChevronRight, Code, Download, ExternalLink, Eye, FileWarning, Link as LinkIcon, ZoomIn, ZoomOut } from "lucide-react"
import { useArtifacts } from "../lib/queries"
import {
  CSV_ROW_LIMIT,
  TEXT_PREVIEW_MAX,
  fileNameOf,
  isTextKind,
  lineNumbers,
  parseCsv,
  parsePreviewKey,
  prettyJson,
  previewKey,
  previewKind,
  type PreviewItem,
  type PreviewKind,
} from "../lib/filePreview"
import { PREVIEW_PARAM, closePreview, stepPreview, usePreviewState } from "../lib/preview"
import { copyText } from "../lib/clipboard"
import { toast } from "../lib/toast"
import { FIT, TAP_SLOP_PX, clampView, isDoubleTap, maxScale, pinchView, swipeAction, zoomAt, zoomStep, type Point, type Tap, type View } from "../lib/imageGestures"
import { DismissButton, Modal, type ModalSize } from "./Modal"
import { Loading } from "./Loading"
import { formatSize } from "./Attachments"
import { isTyping } from "./TaskFilters"
import { Markdown, NewTabLink, cx } from "./ui"
import type { Artifact } from "../../../shared/types"

/** Mounted once in the app: shows the file named by `?preview=`. */
export function FilePreviewHost() {
  const [params] = useSearchParams()
  const key = params.get(PREVIEW_PARAM)
  const state = usePreviewState()
  const artifacts = useArtifacts()
  const parsed = parsePreviewKey(key)
  if (!key || !parsed) return null

  // Opened by a click: the store has the item and its gallery. Opened from a URL (reload, back/forward): look it up.
  const fromStore = state && previewKey(state.items[state.index]!.url) === key ? state : null
  let item: PreviewItem | null = fromStore ? fromStore.items[fromStore.index]! : "url" in parsed ? { url: parsed.url } : null
  const artifactId = "artifactId" in parsed ? parsed.artifactId : /^\/artifacts\/(art_[^/]+)\//.exec(item?.url ?? "")?.[1]
  const artifact = artifactId ? artifacts.data?.find((a) => a.id === artifactId) : undefined
  if (artifact) item = withArtifact(item, artifact)

  if (!item) {
    return (
      <Modal size="sm" title="Preview" onClose={closePreview}>
        {artifacts.isLoading ? <FileLoading /> : <Problem message="This file doesn't exist anymore." />}
      </Modal>
    )
  }
  const gallery = fromStore && fromStore.items.length > 1 ? fromStore : null
  return (
    <FilePreview
      item={item}
      position={gallery ? [gallery.index + 1, gallery.items.length] : null}
      noun={gallery && gallery.items.some((g) => previewKind(g) !== "image") ? "file" : "image"}
    />
  )
}

function withArtifact(item: PreviewItem | null, a: Artifact): PreviewItem {
  return {
    url: item?.url ?? a.url,
    name: item?.name ?? a.filename,
    size: item?.size ?? a.size,
    mime: item?.mime ?? a.mime,
    title: a.title && a.title !== a.filename ? a.title : undefined,
  }
}

const SIZE: Record<PreviewKind, ModalSize> = {
  image: "full",
  html: "full",
  pdf: "full",
  markdown: "xl",
  json: "xl",
  csv: "xl",
  text: "xl",
  video: "xl",
  audio: "md",
}

/** Kinds that fill a fixed-height panel; the rest grow with their content up to the viewport. */
const TALL: PreviewKind[] = ["image", "html", "pdf"]

/**
 * One file, or one of a gallery (`position`: where it is, of how many; `noun`: what the gallery steps through).
 * A gallery keeps one frame for every kind, so stepping from a screenshot to a log never resizes the dialog: an image
 * has an arrow on each side, any other kind a pager under it, where nothing covers the text.
 */
function FilePreview({ item, position, noun }: { item: PreviewItem; position: [number, number] | null; noun: "image" | "file" }) {
  const kind = previewKind(item)
  const image = kind === "image"
  const name = item.name || fileNameOf(item.url)
  const heading = item.title || name
  const [raw, setRaw] = useState(false)
  // The image owns its zoom (ImageView). This copy only draws the button's state and hides the arrows; the button
  // and Z ask for a toggle through the ref.
  const [zoomed, setZoomed] = useState(false)
  const toggleZoom = useRef<(() => void) | null>(null)
  useEffect(() => {
    setRaw(false)
    setZoomed(false)
  }, [item.url])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTyping(e) || e.shiftKey) return
      if (position && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault()
        stepPreview(e.key === "ArrowLeft" ? -1 : 1)
      } else if (image && (e.key === "z" || e.key === "Z")) {
        e.preventDefault()
        toggleZoom.current?.()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [image, position])

  const place = position ? `${position[0]} of ${position[1]}` : null
  // An image has no pager row, so its place in the gallery goes here.
  const details = [image ? place : null, heading !== name ? name : null, item.size ? formatSize(item.size) : null].filter(Boolean).join(" · ")

  return (
    <Modal
      size={position ? "full" : kind ? SIZE[kind] : "md"}
      label={name}
      onClose={closePreview}
      className={cx((position || (kind && TALL.includes(kind))) && "sm:h-[85vh]", !position && kind && isTextKind(kind) && "sm:max-h-[85vh]")}
      bodyClassName="relative flex min-h-0 flex-1 flex-col"
    >
      {/* Narrow (a phone): the title keeps the first row to itself, next to Close, and the actions take a second. */}
      <header className="@container shrink-0 border-b border-zinc-900">
        <div className="flex flex-wrap items-center gap-x-1 py-2 pr-2 pl-4 @md:min-h-14 @md:flex-nowrap @md:gap-x-2 sm:py-2.5 sm:pr-3 sm:pl-5">
          <div className="min-w-0 flex-1 basis-[calc(100%-3.5rem)] @md:basis-0">
            <h2 className="line-clamp-2 text-sm font-semibold wrap-anywhere text-zinc-50" title={heading}>
              {heading}
            </h2>
            {details && (
              <p className="line-clamp-2 text-xs wrap-anywhere text-zinc-500" title={name}>
                {details}
              </p>
            )}
          </div>
          <div className="order-last flex w-full items-center justify-end gap-1 @md:order-none @md:w-auto @md:gap-2">
            {(kind === "markdown" || kind === "json" || kind === "csv") && (
              <ToolButton label={raw ? (kind === "csv" ? "Show table" : kind === "json" ? "Show formatted" : "Show rendered") : "Show raw"} active={raw} onClick={() => setRaw((r) => !r)}>
                {raw ? <Eye className="h-4 w-4" /> : <Code className="h-4 w-4" />}
                <span className="hidden sm:inline">Raw</span>
              </ToolButton>
            )}
            {image && (
              <ToolButton label={zoomed ? "Fit to screen (Z)" : "Zoom in (Z)"} active={zoomed} onClick={() => toggleZoom.current?.()}>
                {zoomed ? <ZoomOut className="h-4 w-4" /> : <ZoomIn className="h-4 w-4" />}
              </ToolButton>
            )}
            <FileActions key={item.url} url={item.url} name={name} />
          </div>
          <DismissButton kind="close" onClick={closePreview} />
        </div>
      </header>
      <PreviewBody key={item.url} item={item} kind={kind} name={name} raw={raw} gallery={!!position} toggleZoom={toggleZoom} onZoom={setZoomed} onStep={position ? stepPreview : undefined} />
      {/* A zoomed image pans under the pointer, so its arrows step aside: ←/→ still step. */}
      {position && image && !zoomed && (
        <>
          <StepButton side="left" noun={noun} />
          <StepButton side="right" noun={noun} />
        </>
      )}
      {position && !image && (
        <nav aria-label="Files" className="flex shrink-0 items-center justify-center gap-1 border-t border-zinc-900 px-2 py-1">
          <StepButton side="left" noun={noun} inline />
          <span className="min-w-16 text-center text-xs text-zinc-400 tabular-nums" aria-live="polite">
            {place}
          </span>
          <StepButton side="right" noun={noun} inline />
        </nav>
      )}
    </Modal>
  )
}

function ToolButton({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cx(
        "relative inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1 rounded-md p-1.5 text-xs font-medium hover:bg-zinc-800 hover:text-zinc-100 sm:min-h-0 sm:min-w-0",
        active ? "bg-zinc-800 text-zinc-100" : "text-zinc-400",
      )}
    >
      {children}
    </button>
  )
}

const actionClass = "inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 sm:min-h-0 sm:min-w-0"

function FileActions({ url, name }: { url: string; name: string }) {
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(null), copied === "failed" ? 4000 : 1500)
    return () => clearTimeout(t)
  }, [copied])
  // copyText also works over plain http on the LAN, where navigator.clipboard doesn't exist.
  const copy = async () => {
    if (await copyText(new URL(url, window.location.origin).href)) return setCopied("copied")
    setCopied("failed")
    toast.error("Couldn't copy the link", "The browser blocked clipboard access.")
  }
  return (
    <>
      <NewTabLink href={url} mark={false} className={actionClass} title="Open in new tab" aria-label="Open in new tab">
        <ExternalLink className="h-4 w-4" />
      </NewTabLink>
      <a href={url} download={name} className={actionClass} title="Download" aria-label="Download">
        <Download className="h-4 w-4" />
      </a>
      <ToolButton label={copied === "copied" ? "Copied" : "Copy link"} onClick={() => void copy()}>
        {copied === "copied" ? <Check className="h-4 w-4 text-emerald-400" /> : <LinkIcon className={cx("h-4 w-4", copied === "failed" && "text-red-400")} />}
        {/* Announced either way. A failure is also shown here: the toast sits under this dialog. */}
        <span
          role="status"
          className={
            copied === "failed"
              ? "pointer-events-none absolute top-full right-0 z-20 mt-1 rounded-md bg-zinc-800 px-2 py-1 text-[11px] font-medium whitespace-nowrap text-red-200 shadow-lg ring-1 ring-zinc-700"
              : "sr-only"
          }
        >
          {copied === "copied" ? "Link copied" : copied === "failed" ? "Couldn't copy the link" : ""}
        </span>
      </ToolButton>
    </>
  )
}

/** Steps through the gallery: floating at an image's side, or `inline` in the pager row under any other kind. */
function StepButton({ side, noun, inline = false }: { side: "left" | "right"; noun: "image" | "file"; inline?: boolean }) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight
  return (
    <button
      type="button"
      onClick={() => stepPreview(side === "left" ? -1 : 1)}
      aria-label={side === "left" ? `Previous ${noun} (←)` : `Next ${noun} (→)`}
      title={side === "left" ? "Previous (←)" : "Next (→)"}
      className={cx(
        "grid h-11 w-11 shrink-0 place-items-center focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none",
        inline
          ? "rounded-md text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50"
          : "absolute top-1/2 z-10 rounded-full bg-zinc-950/70 text-zinc-300 shadow-lg ring-1 ring-zinc-800 backdrop-blur hover:bg-zinc-900 hover:text-zinc-50 sm:h-10 sm:w-10",
        !inline && (side === "left" ? "left-3" : "right-3"),
      )}
    >
      <Icon className="h-5 w-5" />
    </button>
  )
}

/** A file that is still loading: the shared skeleton, as lines of text. It holds the body's space and shows after 300 ms. */
function FileLoading() {
  return (
    <div className="min-w-0 flex-1 px-4 py-5 sm:px-6">
      <Loading kind="chat" label="Loading file" className="mx-auto max-w-4xl" />
    </div>
  )
}

function Problem({ message, url }: { message: string; url?: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center text-sm text-zinc-400">
      <FileWarning className="h-8 w-8 text-zinc-600" />
      <p>{message}</p>
      {url && (
        <NewTabLink href={url} mark={false} className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700">
          <ExternalLink className="h-3.5 w-3.5" /> Open in new tab
        </NewTabLink>
      )}
    </div>
  )
}

function PreviewBody({
  item,
  kind,
  name,
  raw,
  gallery,
  toggleZoom,
  onZoom,
  onStep,
}: {
  item: PreviewItem
  kind: PreviewKind | null
  name: string
  raw: boolean
  /** One of a gallery, whose frame has a fixed height: the content fills it. */
  gallery: boolean
  /** Where the image puts its zoom toggle, for the header's button and Z. */
  toggleZoom: ZoomToggle
  onZoom: (z: boolean) => void
  /** Steps through the gallery, when there is one. */
  onStep?: (delta: number) => void
}) {
  switch (kind) {
    case "image":
      return <ImageView url={item.url} name={name} toggleRef={toggleZoom} onZoom={onZoom} onStep={onStep} onClose={closePreview} />
    case "html":
      // No allow-same-origin: the page runs its scripts but can't reach Box Yard's cookies or API.
      return <FrameView url={item.url} name={name} sandbox="allow-scripts" />
    case "pdf":
      // Browsers won't run their PDF viewer in a sandboxed frame.
      return <FrameView url={item.url} name={name} />
    case "video":
      return <MediaView url={item.url} kind="video" fill={gallery} />
    case "audio":
      return <MediaView url={item.url} kind="audio" fill={gallery} />
    case "markdown":
    case "json":
    case "csv":
    case "text":
      return <TextPreview item={item} kind={kind} raw={raw} />
    default:
      return <Problem message="This file type can't be previewed." url={item.url} />
  }
}

// ------------------------------------------------------------------ images

/** One finger on the image (a mouse, a pen): a tap, a pan while zoomed, or a swipe at fit size. */
type Drag = { kind: "drag"; id: number; start: Point; t: number; view: View; moved: boolean; mouse: boolean; onImage: boolean; swipe: boolean; axis?: "x" | "y" }
/** Two fingers: `from` is their midpoint when the pinch started (relative to the stage's centre), `dist` their distance. */
type Pinch = { kind: "pinch"; view: View; from: Point; dist: number }

const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

/** The shown image's zoom toggle (null while no image is up): how the header's button and Z reach ImageView. */
type ZoomToggle = { current: (() => void) | null }

/** Two mouse presses this close together are one double click. */
const DOUBLE_CLICK_MS = 500

/**
 * An image fitted to the stage. A click, a double tap, Z or the zoom button zooms in about that spot; pinch, Ctrl+wheel
 * or a trackpad pinch zoom freely; one finger, a mouse drag or the wheel pans while zoomed. At fit size a swipe left or
 * right steps through the gallery (`onStep`) and a swipe down closes. The image follows the finger, with no animation.
 * The view here is the only zoom state: the header asks for a toggle through `toggleRef` and hears the outcome through
 * `onZoom`, never the other way round (two copies kept in step by effects chased each other after a double click).
 */
function ImageView({
  url,
  name,
  toggleRef,
  onZoom,
  onStep,
  onClose,
}: {
  url: string
  name: string
  toggleRef: ZoomToggle
  /** Told when the image crosses fit size, for the header button's pressed state. */
  onZoom: (z: boolean) => void
  onStep?: (delta: number) => void
  onClose: () => void
}) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading")
  const [view, setView] = useState<View>(FIT)
  const viewRef = useRef(view)
  viewRef.current = view
  const box = useRef<HTMLDivElement>(null)
  const img = useRef<HTMLImageElement>(null)
  const pointers = useRef(new Map<number, Point>())
  const gesture = useRef<Drag | Pinch | null>(null)
  const lastTap = useRef<Tap | null>(null)

  /** The sizes the maths needs. Layout sizes, so the transform doesn't change them; null before the image loads. */
  const measure = () => {
    const el = box.current
    const i = img.current
    if (!el || !i || !i.offsetWidth || !i.offsetHeight) return null
    const fit = { width: i.offsetWidth, height: i.offsetHeight }
    const r = el.getBoundingClientRect()
    return {
      fit,
      natural: { width: i.naturalWidth, height: i.naturalHeight },
      stage: { width: el.clientWidth, height: el.clientHeight },
      /** A client point relative to the stage's centre. */
      at: (p: Point): Point => ({ x: p.x - r.left - el.clientWidth / 2, y: p.y - r.top - el.clientHeight / 2 }),
    }
  }
  type Measured = NonNullable<ReturnType<typeof measure>>
  const clamped = (v: View, m: Measured) => clampView(v, m.fit, m.stage, maxScale(m.natural, m.fit))
  /** Zoomed: back to fit. At fit: in, about `client` (a click or tap) or the centre. */
  const toggleZoom = (client?: Point) => {
    const m = measure()
    if (!m) return
    if (viewRef.current.scale > 1) return setView(FIT)
    setView(clamped(zoomAt(FIT, zoomStep(m.natural, m.fit), client ? m.at(client) : { x: 0, y: 0 }), m))
  }

  const isZoomed = view.scale > 1
  useEffect(() => {
    toggleRef.current = () => toggleZoom()
    return () => {
      toggleRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toggleRef])
  useEffect(() => onZoom(isZoomed), [isZoomed, onZoom])

  // Ctrl+wheel (a trackpad pinch is one) zooms about the pointer; the wheel pans while zoomed. Not passive, so the
  // page itself doesn't zoom or scroll.
  useEffect(() => {
    const el = box.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      const m = measure()
      if (!m) return
      const v = viewRef.current
      const unit = e.deltaMode === 1 ? 16 : 1
      if (e.ctrlKey) {
        e.preventDefault()
        const step = Math.max(-50, Math.min(50, e.deltaY * unit))
        setView(clamped(zoomAt(v, v.scale * Math.exp(-step * 0.01), m.at({ x: e.clientX, y: e.clientY })), m))
      } else if (v.scale > 1) {
        e.preventDefault()
        setView(clamped({ ...v, x: v.x - e.deltaX * unit, y: v.y - e.deltaY * unit }, m))
      }
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const startPinch = () => {
    const [a, b] = [...pointers.current.values()]
    const m = measure()
    if (!a || !b || !m) return
    gesture.current = { kind: "pinch", view: viewRef.current, from: m.at(midpoint(a, b)), dist: Math.hypot(a.x - b.x, a.y - b.y) || 1 }
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2) return startPinch()
    if (pointers.current.size > 2) return
    const mouse = e.pointerType === "mouse"
    gesture.current = {
      kind: "drag",
      id: e.pointerId,
      start: { x: e.clientX, y: e.clientY },
      t: e.timeStamp,
      view: viewRef.current,
      moved: false,
      mouse,
      onImage: e.target === img.current,
      // A mouse drag at fit size does nothing: the desktop has ←/→ and the backdrop.
      swipe: !mouse && viewRef.current.scale <= 1,
    }
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const g = gesture.current
    if (g?.kind === "pinch") {
      const [a, b] = [...pointers.current.values()]
      const m = measure()
      if (!a || !b || !m) return
      return setView(clamped(pinchView(g.view, g.from, m.at(midpoint(a, b)), Math.hypot(a.x - b.x, a.y - b.y) / g.dist), m))
    }
    if (g?.kind !== "drag" || g.id !== e.pointerId) return
    const dx = e.clientX - g.start.x
    const dy = e.clientY - g.start.y
    if (!g.moved && Math.hypot(dx, dy) < TAP_SLOP_PX) return
    g.moved = true
    if (g.view.scale > 1) {
      const m = measure()
      if (m) setView(clamped({ ...g.view, x: g.view.x + dx, y: g.view.y + dy }, m))
    } else if (g.swipe) {
      // Follow the finger along the axis it set off on: sideways only with a gallery, down only to close.
      g.axis ??= Math.abs(dx) > Math.abs(dy) ? "x" : "y"
      setView({ scale: 1, x: g.axis === "x" && onStep ? dx : 0, y: g.axis === "y" ? Math.max(0, dy) : 0 })
    }
  }

  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(e.pointerId)) return
    const g = gesture.current
    if (g?.kind === "pinch") {
      // One finger left: it pans on from here, but never swipes or taps.
      const [rest] = [...pointers.current.entries()]
      gesture.current = rest
        ? { kind: "drag", id: rest[0], start: rest[1], t: e.timeStamp, view: viewRef.current, moved: true, mouse: false, onImage: false, swipe: false }
        : null
      return
    }
    if (g?.kind !== "drag" || g.id !== e.pointerId) return
    gesture.current = null
    if (e.type === "pointercancel") {
      if (viewRef.current.scale <= 1) setView(FIT)
      return
    }
    const point = { x: e.clientX, y: e.clientY }
    if (!g.moved) {
      const tap = { ...point, t: e.timeStamp }
      if (g.mouse) {
        if (!g.onImage) return
        // A double click zooms once: its second press would only undo the first.
        const second = e.detail > 1 || isDoubleTap(lastTap.current, tap, DOUBLE_CLICK_MS)
        lastTap.current = second ? null : tap
        if (!second) toggleZoom(point)
        return
      }
      if (isDoubleTap(lastTap.current, tap)) {
        lastTap.current = null
        toggleZoom(point)
      } else lastTap.current = tap
      return
    }
    if (!g.swipe) return
    setView(FIT)
    const action = swipeAction(point.x - g.start.x, point.y - g.start.y, e.timeStamp - g.t)
    if (action === "close") onClose()
    else if (action && onStep) onStep(action === "next" ? 1 : -1)
  }

  return (
    <div
      ref={box}
      data-testid="image-stage"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      className={cx(
        // touch-none: the stage, not the page, takes pinches and swipes.
        "relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden bg-[repeating-conic-gradient(#18181b_0%_25%,#111113_0%_50%)] bg-[length:24px_24px] p-4 select-none",
        isZoomed && "cursor-grab active:cursor-grabbing",
      )}
    >
      {status === "loading" && (
        <div className="absolute inset-0 flex">
          <FileLoading />
        </div>
      )}
      {status === "error" ? (
        <Problem message="Couldn't load this image." url={url} />
      ) : (
        <img
          ref={img}
          src={url}
          alt={name}
          draggable={false}
          onLoad={() => setStatus("ready")}
          onError={() => setStatus("error")}
          style={view === FIT ? undefined : { transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          className={cx("max-h-full max-w-full object-contain select-none", !isZoomed && "cursor-zoom-in", status !== "ready" && "invisible")}
        />
      )}
    </div>
  )
}

// ------------------------------------------------------------------ frames and media

function FrameView({ url, name, sandbox }: { url: string; name: string; sandbox?: string }) {
  const [loaded, setLoaded] = useState(false)
  return (
    <div className="relative min-h-0 flex-1 bg-white">
      {!loaded && (
        <div className="absolute inset-0 flex bg-zinc-950">
          <FileLoading />
        </div>
      )}
      <iframe src={url} title={name} sandbox={sandbox} onLoad={() => setLoaded(true)} className="h-full w-full border-0" />
    </div>
  )
}

/** `fill`: in a gallery's fixed frame the video takes the whole stage, so its controls never fall below the pager. */
function MediaView({ url, kind, fill }: { url: string; kind: "video" | "audio"; fill: boolean }) {
  const [error, setError] = useState(false)
  if (error) return <Problem message={`Couldn't play this ${kind === "video" ? "video" : "audio file"}.`} url={url} />
  return kind === "video" ? (
    <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black">
      <video src={url} controls autoPlay className={fill ? "absolute inset-0 h-full w-full" : "max-h-[75vh] max-w-full"} onError={() => setError(true)} />
    </div>
  ) : (
    <div className={cx("px-5 py-8", fill && "flex min-h-0 flex-1 items-center")}>
      <audio src={url} controls autoPlay className="mx-auto block w-full max-w-xl" onError={() => setError(true)} />
    </div>
  )
}

// ------------------------------------------------------------------ text

type TextState = { status: "loading" } | { status: "ready"; text: string } | { status: "error"; message: string } | { status: "too-large"; size: number }

/** The file as text, unless it's over TEXT_PREVIEW_MAX. */
function useFileText(url: string, size?: number): TextState {
  const [state, setState] = useState<TextState>(() => (size && size > TEXT_PREVIEW_MAX ? { status: "too-large", size } : { status: "loading" }))
  useEffect(() => {
    if (size && size > TEXT_PREVIEW_MAX) return
    const ctl = new AbortController()
    setState({ status: "loading" })
    fetch(url, { signal: ctl.signal })
      .then(async (res) => {
        if (!res.ok) return setState({ status: "error", message: res.status === 404 ? "This file doesn't exist anymore." : `Couldn't load this file (${res.status}).` })
        const length = Number(res.headers.get("content-length"))
        if (length > TEXT_PREVIEW_MAX) {
          ctl.abort()
          return setState({ status: "too-large", size: length })
        }
        const text = await res.text()
        setState(text.length > TEXT_PREVIEW_MAX ? { status: "too-large", size: text.length } : { status: "ready", text })
      })
      .catch((err: unknown) => {
        if (!ctl.signal.aborted) setState({ status: "error", message: `Couldn't load this file${err instanceof Error ? ` (${err.message})` : ""}.` })
      })
    return () => ctl.abort()
  }, [url, size])
  return state
}

function TextPreview({ item, kind, raw }: { item: PreviewItem; kind: "markdown" | "json" | "csv" | "text"; raw: boolean }) {
  const file = useFileText(item.url, item.size)
  if (file.status === "loading") return <FileLoading />
  if (file.status === "error") return <Problem message={file.message} url={item.url} />
  if (file.status === "too-large")
    return <Problem message={`This file is ${formatSize(file.size)}, too big to preview here (the limit is ${formatSize(TEXT_PREVIEW_MAX)}).`} url={item.url} />
  const { text } = file
  if (!raw && kind === "markdown")
    return (
      <div className="prose-doc scroll-thin min-h-0 flex-1 overflow-auto px-4 py-5 text-sm text-zinc-200 sm:px-6">
        {/* A readable column, centred in a gallery's wide frame. */}
        <div className="mx-auto max-w-4xl">
          <Markdown>{text}</Markdown>
        </div>
      </div>
    )
  if (!raw && kind === "csv") return <CsvTable text={text} tsv={/\.tsv$/i.test(item.name || item.url)} />
  if (!raw && kind === "json") {
    const pretty = prettyJson(text)
    if (pretty !== null) return <CodeView text={pretty} />
    return <CodeView text={text} note="This isn't valid JSON, so it's shown as is." />
  }
  return <CodeView text={text} />
}

/** Monospace text with a line-number gutter. Two text nodes, so even a 2 MB log renders quickly. */
function CodeView({ text, note }: { text: string; note?: string }) {
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-auto bg-zinc-950">
      {note && <div className="border-b border-zinc-900 px-4 py-2 text-xs text-amber-300/80">{note}</div>}
      <div className="flex w-max min-w-full font-mono text-xs leading-5">
        <pre aria-hidden className="sticky left-0 shrink-0 border-r border-zinc-900 bg-zinc-950 py-3 pr-3 pl-4 text-right text-zinc-600 select-none">
          {lineNumbers(text)}
        </pre>
        <pre className="py-3 pr-6 pl-4 text-zinc-200">{text}</pre>
      </div>
    </div>
  )
}

function CsvTable({ text, tsv }: { text: string; tsv: boolean }) {
  const rows = parseCsv(text, tsv ? "\t" : ",")
  if (!rows.length) return <Problem message="This file is empty." />
  const [head, ...body] = rows
  const shown = body.slice(0, CSV_ROW_LIMIT)
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-auto">
      {/* Centred in a gallery's wide frame, at least a readable column wide; a wider table scrolls from the left edge. */}
      <div className="mx-auto w-fit min-w-[min(100%,56rem)]">
        <table className="min-w-full border-collapse text-left font-mono text-xs">
          <thead className="sticky top-0 bg-zinc-900">
            <tr>
              {head!.map((h, i) => (
                <th key={i} className="border-b border-zinc-800 px-3 py-2 font-semibold whitespace-nowrap text-zinc-200">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i} className="odd:bg-zinc-900/30">
                {r.map((c, j) => (
                  <td key={j} className="border-b border-zinc-900 px-3 py-1.5 whitespace-nowrap text-zinc-300">
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {body.length > shown.length && (
          <p className="px-3 py-2 text-xs text-zinc-500">
            Showing the first {CSV_ROW_LIMIT.toLocaleString()} of {body.length.toLocaleString()} rows. Use Raw for the rest.
          </p>
        )}
      </div>
    </div>
  )
}
