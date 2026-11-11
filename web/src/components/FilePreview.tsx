// The file preview modal: images in a lightbox, markdown rendered, HTML and PDF in iframes, text and code with line
// numbers (JSON pretty-printed, CSV as a table), video and audio in native players. Mounted once as <FilePreviewHost>;
// links open it through <FileLink> and lib/preview.ts.
import { Fragment, memo, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react"
import { useSearchParams } from "wouter"
import { Check, ChevronLeft, ChevronRight, ChevronsDown, ChevronsUp, Code, Copy, Download, ExternalLink, Eye, FileWarning, Link as LinkIcon, MoreHorizontal, RotateCw, WrapText, ZoomIn, ZoomOut } from "lucide-react"
import { useArtifacts } from "../lib/queries"
import {
  CSV_ROW_LIMIT,
  LINE_ROWS_MAX,
  TEXT_PREVIEW_MAX,
  fileNameOf,
  hangingIndent,
  isTextKind,
  lineCount,
  lineNumbers,
  parseCsv,
  parsePreviewKey,
  prettyJson,
  previewKey,
  previewKind,
  splitLines,
  type PreviewItem,
  type PreviewKind,
} from "../lib/filePreview"
import { PREVIEW_PARAM, closePreview, stepPreview, usePreviewState } from "../lib/preview"
import { copyText } from "../lib/clipboard"
import { toast } from "../lib/toast"
import { FIT, TAP_SLOP_PX, clampView, isDoubleTap, isStrip, maxScale, pinchView, shownPercent, swipeAction, zoomAt, zoomStep, type Point, type Size, type Tap, type View } from "../lib/imageGestures"
import { DismissButton, Modal, type ModalSize } from "./Modal"
import { Loading } from "./Loading"
import { MessageMenu, type MenuItem } from "./MessageActions"
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
        {artifacts.isLoading ? <Loading kind="rows" label="Loading file" count={1} /> : <Problem message="This file doesn't exist anymore." />}
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

/** Wrap long lines of text or code: on, off, or (null) only where the frame is narrow, until the button says otherwise. */
type Wrap = boolean | null

/**
 * A text file's contents once they load, for Copy contents, and how many `lines` its monospace view has. "failed":
 * there is no text, so nothing to wrap or copy.
 */
type TextFile = { text: string; lines: number } | "loading" | "failed"

/** Text with more lines than this (a log) gets Jump to end. */
const JUMP_MIN_LINES = 200

/** The text's scroller, so the header can jump in it, and whether it is scrolled to its end. */
type Scroll = { box: RefObject<HTMLDivElement | null>; onEnd: (atEnd: boolean) => void }

/** In the header only where it is wide (42rem); narrower, the same action is in the header's ⋯. */
const WIDE_ONLY = "@max-2xl/preview:hidden"

/** What Copy link or Copy contents came to, shown for a moment. */
type Flash = { what: "link" | "contents"; ok: boolean }
const FLASH_TEXT = { link: ["Link copied", "Couldn't copy the link"], contents: ["Copied", "Couldn't copy the file"] } as const

/**
 * One file, or one of a gallery (`position`: where it is, of how many; `noun`: what the gallery steps through).
 * A gallery keeps one frame and one pager (under the file, where nothing covers it) for every kind, so stepping from a
 * screenshot to a log never resizes the dialog or moves the buttons, and the pressed one keeps the focus.
 * Wide, the actions sit in the header. Narrow (a phone: the frame's own width, `@container/preview`), the header is the
 * title and Close, and one bar under the file has the pager on the left and the actions on the right, the rarer ones
 * in its ⋯ menu.
 */
function FilePreview({ item, position, noun }: { item: PreviewItem; position: [number, number] | null; noun: "image" | "file" }) {
  const kind = previewKind(item)
  const image = kind === "image"
  const name = item.name || fileNameOf(item.url)
  const heading = item.title || name
  const [raw, setRaw] = useState(false)
  // The image owns its zoom (ImageView). This copy only draws the button's state; the button and Z ask for a toggle
  // through the ref.
  const [zoomed, setZoomed] = useState(false)
  const toggleZoom = useRef<(() => void) | null>(null)
  // Kept from file to file, unlike Raw: someone reading logs wants every one of them wrapped.
  const [wrap, setWrap] = useState<Wrap>(null)
  const [file, setFile] = useState<TextFile>("loading")
  const text = typeof file === "object" ? file.text : null
  const lines = typeof file === "object" ? file.lines : 0
  const failed = file === "failed"
  // The file that turned out to be deleted (its URL): nothing can be done with it, so it gets no actions.
  const [goneUrl, setGoneUrl] = useState<string | null>(null)
  const gone = goneUrl === item.url
  const box = useRef<HTMLDivElement>(null)
  const [atEnd, setAtEnd] = useState(false)
  const scroll = useMemo<Scroll>(() => ({ box, onEnd: setAtEnd }), [])
  // An image's own size once it loads, with its URL: the last image's must never show under the next one's name.
  const [pixels, setPixels] = useState<(Size & { url: string }) | null>(null)
  const [flash, setFlash] = useState<Flash | null>(null)
  useEffect(() => {
    setRaw(false)
    setZoomed(false)
    setFlash(null)
  }, [item.url])
  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), flash.ok ? 1500 : 4000)
    return () => clearTimeout(t)
  }, [flash])

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

  // copyText also works over plain http on the LAN, where navigator.clipboard doesn't exist.
  const copy = async (what: Flash["what"]) => {
    const ok = await copyText(what === "link" ? new URL(item.url, window.location.origin).href : (text ?? ""))
    setFlash({ what, ok })
    if (!ok) toast.error(FLASH_TEXT[what][1], "The browser blocked clipboard access.")
  }
  const copied = (what: Flash["what"]) => !!flash?.ok && flash.what === what

  const details = [heading !== name ? name : null, item.size ? formatSize(item.size) : null, pixels?.url === item.url ? `${pixels.width}×${pixels.height}` : null]
    .filter(Boolean)
    .join(" · ")
  // A file that didn't load has no other view, and no lines to wrap.
  const hasRaw = !failed && (kind === "markdown" || kind === "json" || kind === "csv")
  /** Lines of monospace text are showing (CodeView), so Wrap lines applies. */
  const code = !failed && (kind === "text" || kind === "json" || (raw && hasRaw))
  // With no choice made yet, lines wrap where the frame is narrow (unless the file has more lines than get a row
  // each): each layout's own control says so.
  const wrapWide = wrap ?? false
  const wrapNarrow = wrap ?? lines <= LINE_ROWS_MAX
  /** A long file (a log): its end is what matters, and from there the way back. One control, for whichever applies. */
  const jump = code && lines > JUMP_MIN_LINES ? { icon: atEnd ? ChevronsUp : ChevronsDown, label: atEnd ? "Jump to start" : "Jump to end", word: atEnd ? "Start" : "End" } : null
  const jumpNow = () => box.current?.scrollTo({ top: atEnd ? 0 : box.current.scrollHeight, behavior: "instant" })

  /** Switches the view, so it names the one it goes to. `bar`: the narrow bar's, which keeps the word only while it fits. */
  const rawToggle = (bar: boolean) =>
    hasRaw && (
      <ToolButton label={raw ? (kind === "csv" ? "Show table" : kind === "json" ? "Show formatted" : "Show rendered") : "Show raw"} onClick={() => setRaw((r) => !r)}>
        {raw ? <Eye className="h-4 w-4" /> : <Code className="h-4 w-4" />}
        <span className={cx(bar && "@max-[22rem]/preview:hidden")}>{raw ? (kind === "csv" ? "Table" : kind === "json" ? "Formatted" : "Rendered") : "Raw"}</span>
      </ToolButton>
    )
  const zoom = image && !gone && (
    <ToolButton label={zoomed ? "Fit to screen (Z)" : "Zoom in (Z)"} active={zoomed} onClick={() => toggleZoom.current?.()}>
      {zoomed ? <ZoomOut className="h-4 w-4" /> : <ZoomIn className="h-4 w-4" />}
    </ToolButton>
  )
  /** `bar`: the narrow bar's, an icon like its neighbours; the header's says the word where it is wide. */
  const download = (bar: boolean) =>
    !gone && (
      <a href={item.url} download={name} className={TOOL} title="Download" aria-label="Download">
        <Download className="h-4 w-4" />
        {!bar && <span className={WIDE_ONLY}>Download</span>}
      </a>
    )
  const jumps: MenuItem[] = jump ? [{ icon: jump.icon, label: jump.label, run: jumpNow }] : []
  const copyLink: MenuItem = { icon: LinkIcon, label: "Copy link", run: () => void copy("link") }
  const more: MenuItem[] = [
    ...jumps,
    ...(code ? [{ icon: WrapText, label: wrapNarrow ? "Don't wrap lines" : "Wrap lines", run: () => setWrap(!wrapNarrow) }] : []),
    ...(text !== null ? [{ icon: Copy, label: "Copy contents", run: () => void copy("contents") }] : []),
    { icon: ExternalLink, label: "Open in new tab", run: () => void window.open(item.url, "_blank", "noopener") },
    copyLink,
  ]
  /** The header has controls for the view (the divider's left), not only the file's actions. */
  const views = hasRaw || code || (image && !gone) || (isTextKind(kind) && !failed)

  return (
    <Modal
      size={position ? "full" : kind ? SIZE[kind] : "md"}
      label={name}
      onClose={closePreview}
      // sm: is Modal's own switch from a phone's full screen to a dialog, so the dialog's height goes with it.
      className={cx((position || (kind && TALL.includes(kind))) && "sm:h-[85vh]", !position && kind && isTextKind(kind) && "sm:max-h-[85vh]")}
      bodyClassName="@container/preview relative flex min-h-0 flex-1 flex-col"
    >
      <header className="flex shrink-0 items-center gap-1 border-b border-zinc-900 py-2 pr-2 pl-4 @[30rem]/preview:min-h-14 @[30rem]/preview:gap-2 @[30rem]/preview:pr-3 @[30rem]/preview:pl-5">
        <div className="min-w-0 flex-1">
          <h2 className="line-clamp-2 text-sm font-semibold wrap-anywhere text-zinc-50" title={heading}>
            {heading}
          </h2>
          {details && (
            <p className="line-clamp-2 text-xs wrap-anywhere text-zinc-500" title={name}>
              {details}
            </p>
          )}
        </div>
        {/* The view's controls, a divider, then the file's actions. A deleted file has neither. */}
        <div className="flex shrink-0 items-center gap-2 @max-[30rem]/preview:hidden">
          {rawToggle(false)}
          {/* Worded from 32rem: a bare Copy would be a guess at what it copies. */}
          {code && (
            <ToolButton label="Wrap lines" title={wrapWide ? "Don't wrap lines" : "Wrap lines"} active={wrapWide} onClick={() => setWrap(!wrapWide)}>
              <WrapText className="h-4 w-4" />
              <span className="@max-lg/preview:hidden">Wrap</span>
            </ToolButton>
          )}
          {zoom}
          {isTextKind(kind) && !failed && (
            <ToolButton label={copied("contents") ? "Copied" : "Copy contents"} disabled={text === null} onClick={() => void copy("contents")}>
              {copied("contents") ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
              <span className="@max-lg/preview:hidden">Copy</span>
            </ToolButton>
          )}
          {jump && (
            <ToolButton label={jump.label} className={WIDE_ONLY} onClick={jumpNow}>
              <jump.icon className="h-4 w-4" />
              {/* As wide as the longer word, so the swap moves nothing. */}
              <span className="min-w-8 text-left">{jump.word}</span>
            </ToolButton>
          )}
          {!gone && (
            <>
              {views && <span aria-hidden className="h-5 border-l border-zinc-800" />}
              {download(false)}
              <NewTabLink href={item.url} mark={false} className={TOOL} title="Open in new tab" aria-label="Open in new tab">
                <ExternalLink className="h-4 w-4" />
              </NewTabLink>
              <ToolButton label={copied("link") ? "Copied" : "Copy link"} className={WIDE_ONLY} onClick={() => void copy("link")}>
                {copied("link") ? <Check className="h-4 w-4 text-emerald-400" /> : <LinkIcon className="h-4 w-4" />}
              </ToolButton>
              <MoreActions items={[...jumps, copyLink]} className="@2xl/preview:hidden" />
            </>
          )}
        </div>
        <DismissButton kind="close" onClick={closePreview} />
      </header>
      <PreviewBody
        key={item.url}
        item={item}
        kind={kind}
        name={name}
        raw={raw}
        wrap={wrap}
        gallery={!!position}
        toggleZoom={toggleZoom}
        onZoom={setZoomed}
        onPixels={setPixels}
        onText={setFile}
        onGone={setGoneUrl}
        scroll={scroll}
        onStep={position ? stepPreview : undefined}
      />
      {/* Seen and announced either way, just over the bar: a toast would sit under this dialog. */}
      <div className="relative h-0 shrink-0">
        <p
          role="status"
          className={
            flash
              ? cx("pointer-events-none absolute bottom-2 left-1/2 z-20 -translate-x-1/2 rounded-md bg-zinc-800 px-2.5 py-1 text-xs font-medium whitespace-nowrap shadow-lg ring-1 ring-zinc-700", flash.ok ? "text-zinc-100" : "text-red-200")
              : "sr-only"
          }
        >
          {flash ? FLASH_TEXT[flash.what][flash.ok ? 0 : 1] : ""}
        </p>
      </div>
      {/* Wide, only a gallery has this bar, for its pager; so does a deleted file at any width. */}
      <footer className={cx("flex shrink-0 items-center gap-1 border-t border-zinc-900 px-2 py-1", !position && (gone ? "hidden" : "@[30rem]/preview:hidden"))}>
        {position && (
          <nav aria-label="Files" className="flex items-center gap-1 @[30rem]/preview:mx-auto">
            <StepButton side="left" noun={noun} />
            <span className="min-w-12 text-center text-xs text-zinc-300 tabular-nums" aria-live="polite">
              {position[0]} of {position[1]}
            </span>
            <StepButton side="right" noun={noun} />
          </nav>
        )}
        {!gone && (
          <div className="ml-auto flex items-center gap-1 @[30rem]/preview:hidden">
            {rawToggle(true)}
            {zoom}
            {download(true)}
            <MoreActions items={more} />
          </div>
        )}
      </footer>
    </Modal>
  )
}

/** A header or bar control: drawn 28px, 44px to a finger, whatever the window's width. */
const TOOL =
  "relative inline-flex min-h-7 min-w-7 shrink-0 items-center justify-center gap-1 rounded-md p-1.5 text-xs font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none pointer-coarse:min-h-11 pointer-coarse:min-w-11"

/** `active` makes it a toggle (aria-pressed); `title` is its tooltip when that differs from its name. */
function ToolButton({ label, title = label, active, disabled, className, onClick, children }: { label: string; title?: string; active?: boolean; disabled?: boolean; className?: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={label}
      aria-pressed={active}
      className={cx(TOOL, active && "bg-zinc-800 text-zinc-100", "disabled:text-zinc-700 disabled:hover:bg-transparent", className)}
    >
      {children}
    </button>
  )
}

/** A bar's ⋯: the actions that don't fit it, as a menu over the dialog. */
function MoreActions({ items, className }: { items: MenuItem[]; className?: string }) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
        title="More actions"
        className={cx(TOOL, open && "bg-zinc-800 text-zinc-100", className)}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && <MessageMenu trigger={button} items={items} onClose={() => setOpen(false)} label="More actions" className="z-60!" />}
    </>
  )
}

/** Steps through the gallery, from the pager under the file. */
function StepButton({ side, noun }: { side: "left" | "right"; noun: "image" | "file" }) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight
  return (
    <button
      type="button"
      onClick={() => stepPreview(side === "left" ? -1 : 1)}
      aria-label={side === "left" ? `Previous ${noun} (←)` : `Next ${noun} (→)`}
      title={side === "left" ? "Previous (←)" : "Next (→)"}
      className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50 focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none pointer-coarse:h-11 pointer-coarse:w-11"
    >
      <Icon className="h-5 w-5" />
    </button>
  )
}

/**
 * A file that is still loading: the shared skeleton, which holds its space and shows after 300 ms. Rows where text
 * will be; `stage`: one block over the stage of an image or a page.
 */
function FileLoading({ stage = false }: { stage?: boolean }) {
  if (stage) return <Loading kind="field" label="Loading file" className="absolute inset-4 h-auto! sm:h-auto!" />
  return (
    <div className="min-w-0 flex-1 px-4 py-5 @[30rem]/preview:px-5">
      <Loading kind="rows" label="Loading file" className="max-w-3xl" />
    </div>
  )
}

const PROBLEM_ACTION =
  "inline-flex items-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700 focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none pointer-coarse:min-h-11"

/**
 * A file that can't be shown, said to a screen reader as it appears, with what can still be done.
 * `onRetry`: loading it failed, so loading it again may work. `url`: the browser may still open it. A deleted file
 * gets neither. `dark`: on the image stage, which is dark in both themes, so the text is light in both.
 */
function Problem({ message, url, onRetry, dark }: { message: string; url?: string; onRetry?: () => void; dark?: boolean }) {
  return (
    <div className={cx("flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center text-sm", dark ? "text-[#d4d4d8]" : "text-zinc-400")}>
      <FileWarning className={cx("h-8 w-8", dark ? "text-[#a1a1aa]" : "text-zinc-600")} />
      <p role="status">{message}</p>
      {(onRetry || url) && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {onRetry && (
            <button
              type="button"
              onClick={(e) => {
                // The button goes away with the problem: the dialog keeps the focus, not the page behind it.
                e.currentTarget.closest<HTMLElement>('[role="dialog"]')?.focus({ preventScroll: true })
                onRetry()
              }}
              className={PROBLEM_ACTION}
            >
              <RotateCw className="h-3.5 w-3.5" /> Try again
            </button>
          )}
          {url && (
            <NewTabLink href={url} mark={false} className={PROBLEM_ACTION}>
              <ExternalLink className="h-3.5 w-3.5" /> Open in new tab
            </NewTabLink>
          )}
        </div>
      )}
    </div>
  )
}

function PreviewBody({
  item,
  kind,
  name,
  raw,
  wrap,
  gallery,
  toggleZoom,
  onZoom,
  onPixels,
  onText,
  onGone,
  scroll,
  onStep,
}: {
  item: PreviewItem
  kind: PreviewKind | null
  name: string
  raw: boolean
  wrap: Wrap
  /** One of a gallery, whose frame has a fixed height: the content fills it. */
  gallery: boolean
  /** Where the image puts its zoom toggle, for the header's button and Z. */
  toggleZoom: ZoomToggle
  onZoom: (z: boolean) => void
  /** Told an image's own size once it loads, for the header. */
  onPixels: (size: Size & { url: string }) => void
  /** Told how a text file's loading went, and its contents. */
  onText: (file: TextFile) => void
  /** Told the URL of a file that turned out to be deleted. */
  onGone: (url: string) => void
  scroll: Scroll
  /** Steps through the gallery, when there is one. */
  onStep?: (delta: number) => void
}) {
  switch (kind) {
    case "image":
      return <ImageView url={item.url} name={name} toggleRef={toggleZoom} onZoom={onZoom} onPixels={onPixels} onGone={onGone} onStep={onStep} onClose={closePreview} />
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
      return <TextPreview item={item} kind={kind} name={name} raw={raw} wrap={wrap} onText={onText} onGone={onGone} scroll={scroll} />
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
 * While zoomed, a pill over the stage's bottom edge says how big the image is (of its own pixels) and how to get back.
 */
function ImageView({
  url,
  name,
  toggleRef,
  onZoom,
  onPixels,
  onGone,
  onStep,
  onClose,
}: {
  url: string
  name: string
  toggleRef: ZoomToggle
  /** Told when the image crosses fit size, for the header button's pressed state. */
  onZoom: (z: boolean) => void
  onPixels: (size: Size & { url: string }) => void
  onGone: (url: string) => void
  onStep?: (delta: number) => void
  onClose: () => void
}) {
  // "gone": the file was deleted, so trying again can't help.
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "gone">("loading")
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  /** An <img> doesn't say why it failed: ask the server, as the text preview's fetch does. */
  const onError = () =>
    void fetch(url, { method: "HEAD" })
      .then(
        (res) => res.status === 404,
        () => false,
      )
      .then((gone) => {
        if (!mounted.current) return
        setStatus(gone ? "gone" : "error")
        if (gone) onGone(url)
      })
  /** Counts Try again: a new <img> loads the URL again. */
  const [attempt, setAttempt] = useState(0)
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
  /** Zoomed: back to fit. At fit: in, about `client` (a click or tap), else the centre, or the top of a tall strip. */
  const toggleZoom = (client?: Point) => {
    const m = measure()
    if (!m) return
    if (viewRef.current.scale > 1) return setView(FIT)
    const about = client ? m.at(client) : { x: 0, y: isStrip(m.natural, m.fit, m.stage) ? -m.fit.height / 2 : 0 }
    setView(clamped(zoomAt(FIT, zoomStep(m.natural, m.fit, m.stage), about), m))
  }

  const isZoomed = view.scale > 1
  // Layout sizes, which the transform doesn't change: reading them while it renders costs nothing.
  const shown = isZoomed && img.current ? shownPercent(view.scale, { width: img.current.naturalWidth, height: img.current.naturalHeight }, { width: img.current.offsetWidth, height: img.current.offsetHeight }) : 0
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
    // A failed image's buttons take their own presses: captured by the stage, their click would never arrive.
    if ((e.target as Element).closest("a, button")) return
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
        "relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden p-4 select-none",
        // The checkerboard is for an image's transparency: with no image to show, the stage is plain.
        status === "gone" || status === "error" ? "bg-[#18181b]" : "bg-[repeating-conic-gradient(#18181b_0%_25%,#111113_0%_50%)] bg-[length:24px_24px]",
        isZoomed && "cursor-grab active:cursor-grabbing",
      )}
    >
      {status === "loading" && (
        <FileLoading stage />
      )}
      {status === "gone" ? (
        <Problem dark message="This file doesn't exist anymore." />
      ) : status === "error" ? (
        <Problem
          dark
          message="Couldn't load this image."
          url={url}
          onRetry={() => {
            setStatus("loading")
            setAttempt((a) => a + 1)
          }}
        />
      ) : (
        <img
          key={attempt}
          ref={img}
          src={url}
          alt={name}
          draggable={false}
          onLoad={(e) => {
            setStatus("ready")
            const { naturalWidth: width, naturalHeight: height } = e.currentTarget
            if (width && height) onPixels({ url, width, height })
          }}
          onError={onError}
          style={view === FIT ? undefined : { transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          className={cx("max-h-full max-w-full object-contain select-none", !isZoomed && "cursor-zoom-in", status !== "ready" && "invisible")}
        />
      )}
      {/* Always here, so a screen reader hears it change; shown only while zoomed. */}
      <p
        role="status"
        data-testid="zoom-status"
        className={isZoomed ? "pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full bg-zinc-950/80 px-2.5 py-1 text-xs whitespace-nowrap text-zinc-200 tabular-nums" : "sr-only"}
      >
        {isZoomed && (
          <>
            {shown}% · <span className="pointer-coarse:hidden">click or press Z</span>
            <span className="hidden pointer-coarse:inline">double-tap</span> to fit
          </>
        )}
      </p>
    </div>
  )
}

// ------------------------------------------------------------------ frames and media

function FrameView({ url, name, sandbox }: { url: string; name: string; sandbox?: string }) {
  const [loaded, setLoaded] = useState(false)
  return (
    <div className="relative min-h-0 flex-1 bg-white">
      {!loaded && (
        <div className="absolute inset-0 bg-zinc-950">
          <FileLoading stage />
        </div>
      )}
      <iframe src={url} title={name} sandbox={sandbox} onLoad={() => setLoaded(true)} className="h-full w-full border-0" />
    </div>
  )
}

/** `fill`: in a gallery's fixed frame the video takes the whole stage, so its controls never fall below the pager. */
function MediaView({ url, kind, fill }: { url: string; kind: "video" | "audio"; fill: boolean }) {
  const [error, setError] = useState(false)
  if (error) return <Problem message={`Couldn't play this ${kind === "video" ? "video" : "audio file"}.`} url={url} onRetry={() => setError(false)} />
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

type TextState = { status: "loading" } | { status: "ready"; text: string } | { status: "error"; message: string; gone?: boolean } | { status: "too-large"; size: number }

/** The file as text, unless it's over TEXT_PREVIEW_MAX, and a way to fetch it again after an error. */
function useFileText(url: string, size?: number): [TextState, () => void] {
  const [state, setState] = useState<TextState>(() => (size && size > TEXT_PREVIEW_MAX ? { status: "too-large", size } : { status: "loading" }))
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (size && size > TEXT_PREVIEW_MAX) return
    const ctl = new AbortController()
    setState({ status: "loading" })
    fetch(url, { signal: ctl.signal })
      .then(async (res) => {
        if (!res.ok) return setState(res.status === 404 ? { status: "error", message: "This file doesn't exist anymore.", gone: true } : { status: "error", message: `Couldn't load this file (${res.status}).` })
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
  }, [url, size, attempt])
  return [state, () => setAttempt((a) => a + 1)]
}

function TextPreview({
  item,
  kind,
  name,
  raw,
  wrap,
  onText,
  onGone,
  scroll,
}: {
  item: PreviewItem
  kind: "markdown" | "json" | "csv" | "text"
  name: string
  raw: boolean
  wrap: Wrap
  onText: (file: TextFile) => void
  onGone: (url: string) => void
  scroll: Scroll
}) {
  const [file, retry] = useFileText(item.url, item.size)
  const text = file.status === "ready" ? file.text : null
  const pretty = useMemo(() => (text !== null && kind === "json" && !raw ? prettyJson(text) : null), [text, kind, raw])
  /** What CodeView shows, when it is what shows. */
  const shown = pretty ?? text
  const lines = useMemo(() => (shown === null ? 0 : lineCount(shown)), [shown])
  const status = file.status
  const gone = file.status === "error" && !!file.gone
  useEffect(() => {
    onText(text !== null ? { text, lines } : status === "loading" ? "loading" : "failed")
    return () => onText("loading")
  }, [text, lines, status, onText])
  useEffect(() => {
    if (gone) onGone(item.url)
  }, [gone, item.url, onGone])
  if (file.status === "loading") return <FileLoading />
  // A file that is gone stays gone; any other failure may have been the network.
  if (file.status === "error") return file.gone ? <Problem message={file.message} /> : <Problem message={file.message} url={item.url} onRetry={retry} />
  if (file.status === "too-large")
    return <Problem message={`This file is ${formatSize(file.size)}, too big to preview here (the limit is ${formatSize(TEXT_PREVIEW_MAX)}).`} url={item.url} />
  if (text === null) return null
  if (!raw && kind === "markdown")
    return (
      <div className="prose-doc scroll-thin min-h-0 flex-1 overflow-auto px-4 py-5 text-sm text-zinc-200 @[30rem]/preview:px-5">
        {/* A readable column on the header's left edge, however wide the frame. */}
        <div className="max-w-3xl">
          <Markdown>{text}</Markdown>
        </div>
      </div>
    )
  if (!raw && kind === "csv") return <CsvTable text={text} tsv={/\.tsv$/i.test(item.name || item.url)} />
  if (!raw && kind === "json") {
    if (pretty !== null) return <CodeView text={pretty} name={name} wrap={wrap} scroll={scroll} />
    return <CodeView text={text} name={name} wrap={wrap} scroll={scroll} note="This isn't valid JSON, so it's shown as is." />
  }
  return <CodeView text={text} name={name} wrap={wrap} scroll={scroll} />
}

// CodeView's classes by Wrap: on, off, and (null) on only where the frame is narrow.
const CODE = "font-mono text-xs leading-5 @3xl/preview:text-[13px]"
const CODE_WIDTH = { on: "w-full", off: "w-max min-w-full", auto: "w-full @[30rem]/preview:w-max @[30rem]/preview:min-w-full" }
const CODE_LINE = {
  on: "pr-4 wrap-anywhere whitespace-pre-wrap",
  off: "pr-6 whitespace-pre",
  auto: "pr-4 wrap-anywhere whitespace-pre-wrap @[30rem]/preview:pr-6 @[30rem]/preview:wrap-normal @[30rem]/preview:whitespace-pre",
}
// A wrapped line's later rows start under its first character, not under the gutter: --hang is the line's own indent
// (hangingIndent), taken back from the first row and added to the padding of all of them.
const CODE_HANG = "pl-[calc(0.75rem+var(--hang,0ch))] [text-indent:calc(var(--hang,0ch)*-1)] @[30rem]/preview:pl-[calc(1rem+var(--hang,0ch))]"
const CODE_NUMBER = "sticky left-0 border-r border-zinc-900 bg-zinc-950 pr-2 pl-3 text-right text-zinc-600 select-none @[30rem]/preview:pr-3 @[30rem]/preview:pl-4"

/**
 * Monospace text with a line-number gutter. One row per line (its number, its text), so a long line that wraps keeps
 * its number beside its first row and the rows under it are plainly its own. Over LINE_ROWS_MAX lines it is two text
 * nodes instead, so even a 2 MB log renders quickly: those don't wrap unless asked to, and then without the gutter (its
 * numbers would no longer line up). `wrap` null: wrapped only where the frame is narrow.
 * `scroll`: where it leaves its scroller for Jump to end, and says when it is scrolled to its end.
 * The scroller takes the focus (named after the file), so the keyboard can scroll it.
 */
const CodeView = memo(function CodeView({ text, name, note, wrap, scroll }: { text: string; name: string; note?: string; wrap: Wrap; scroll: Scroll }) {
  const rows = useMemo(() => (lineCount(text) > LINE_ROWS_MAX ? null : splitLines(text)), [text])
  const mode = wrap === null ? "auto" : wrap ? "on" : "off"
  const atEnd = useRef(false)
  const check = () => {
    const el = scroll.box.current
    // Not a text that fits its frame: that one is at its start.
    const now = !!el && el.scrollTop > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 2
    if (now !== atEnd.current) scroll.onEnd((atEnd.current = now))
  }
  // Wrapping (or another form of the text) changes its height under the same scroll position.
  useEffect(check, [text, mode])
  // Gone with this view (another file, the rendered form): so is "at its end".
  useEffect(() => () => scroll.onEnd(false), [scroll])
  return (
    <div
      ref={scroll.box}
      tabIndex={0}
      role="region"
      aria-label={name}
      onScroll={check}
      // The focus outline inside the frame: the dialog would clip one drawn around it.
      className="scroll-thin min-h-0 flex-1 overflow-auto bg-zinc-950 focus-visible:-outline-offset-2!"
    >
      {note && <div className="border-b border-zinc-900 px-4 py-2 text-xs text-amber-300/80">{note}</div>}
      {rows ? (
        <pre className={cx("grid grid-cols-[auto_minmax(0,1fr)]", CODE, CODE_WIDTH[mode])}>
          {rows.map((line, i) => {
            // The block's padding, on its first and last rows, so the gutter's edge runs its whole height.
            const pad = cx(i === 0 && "pt-3", i === rows.length - 1 && "pb-3")
            const hang = hangingIndent(line)
            return (
              <Fragment key={i}>
                <span aria-hidden className={cx(CODE_NUMBER, pad)}>
                  {i + 1}
                </span>
                {/* Its newline is the text's own: what a selection copies, and an empty line's height. */}
                <span style={hang ? ({ "--hang": `${hang}ch` } as CSSProperties) : undefined} className={cx("text-zinc-200", CODE_HANG, CODE_LINE[mode], pad)}>
                  {line + "\n"}
                </span>
              </Fragment>
            )
          })}
        </pre>
      ) : wrap ? (
        <pre className={cx("w-full px-4 py-3 wrap-anywhere whitespace-pre-wrap text-zinc-200", CODE)}>{text}</pre>
      ) : (
        <div className={cx("flex w-max min-w-full", CODE)}>
          <pre aria-hidden className="sticky left-0 shrink-0 border-r border-zinc-900 bg-zinc-950 py-3 pr-3 pl-4 text-right text-zinc-600 select-none">
            {lineNumbers(text)}
          </pre>
          <pre className="py-3 pr-6 pl-4 text-zinc-200">{text}</pre>
        </div>
      )}
    </div>
  )
})

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
