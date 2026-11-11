// A task's published files: one "📎 N files" chip in the header that opens a drawer (a bottom sheet on phones)
// with image thumbnails and a compact list, and the small "published" row in the transcript. Ordering, grouping
// and filtering are in lib/taskFiles.ts. The drawer's open state lives here, so opening it never re-renders the
// transcript.
import { memo, useCallback, useEffect, useMemo, useState } from "react"
import { File, FileCode, FileImage, FileText, Film, Music, Paperclip, Search, X } from "lucide-react"
import { Modal } from "./Modal"
import { ArtifactLink } from "./FileLink"
import { formatSize } from "./Attachments"
import { HEADER_CHIP, HEADER_FOLD, META_CHIP, TAP_AREA, TimeAgo, cx } from "./ui"
import { useArtifacts } from "../lib/queries"
import { FILTER_MIN, fileKind, fileType, galleryOf, isImageFile, isUnseen, latestAt, listFiles, seenKey, shortTitle, unseenCount, type TaskFile } from "../lib/taskFiles"
import type { PreviewKind } from "../lib/filePreview"
import type { Artifact } from "../../../shared/types"
import { thumbUrl } from "../../../shared/thumbs"

/** The newest file time seen when the list was last opened, per task, in localStorage. */
function useFilesSeen(taskId: string): [number | null, (at: number) => void] {
  const read = () => {
    const v = Number(localStorage.getItem(seenKey(taskId)))
    return Number.isFinite(v) && v > 0 ? v : null
  }
  const [seen, setSeen] = useState(read)
  useEffect(() => setSeen(read()), [taskId])
  const mark = useCallback(
    (at: number) => {
      if (!at) return
      localStorage.setItem(seenKey(taskId), String(at))
      setSeen(at)
    },
    [taskId],
  )
  return [seen, mark]
}

/** `quiet`: the task header's faint pill; `fold`: there, it narrows to the paperclip and the count (HEADER_FOLD). */
export function FilesChip({ taskId, projectId, files, quiet = false, fold = false }: { taskId: string; projectId: string | null; files: Artifact[]; quiet?: boolean; fold?: boolean }) {
  const [open, setOpen] = useState(false)
  const [seen, markSeen] = useFilesSeen(taskId)
  // What was new when the drawer opened stays marked while it is open.
  const [seenAtOpen, setSeenAtOpen] = useState<number | null>(null)
  const fresh = unseenCount(files, seen)
  const latest = latestAt(files)

  useEffect(() => {
    if (open) markSeen(latest)
  }, [open, latest, markSeen])
  useEffect(() => setOpen(false), [taskId])

  if (!files.length) return null
  const label = `${files.length} file${files.length === 1 ? "" : "s"}`
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setSeenAtOpen(seen)
          setOpen(true)
        }}
        aria-haspopup="dialog"
        aria-label={fresh ? `${label}, ${fresh} new` : label}
        title={fresh ? `${label}, ${fresh} new since you last looked` : "Files this task published"}
        className={cx(quiet ? cx(HEADER_CHIP, "bg-zinc-900 font-normal text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200") : cx(META_CHIP, "border-zinc-800 bg-zinc-900/60 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"), fold && HEADER_FOLD.chip, "focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none")}
      >
        <Paperclip className={cx("h-3 w-3 text-zinc-400", fold && HEADER_FOLD.icon)} /> {files.length}
        <span className={cx(fold && HEADER_FOLD.label)}> file{files.length === 1 ? "" : "s"}</span>
        {/* New files since the drawer was last opened (none before it ever was): a dot, with the count in the tooltip and the label. */}
        {fresh > 0 && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400" aria-hidden data-testid="files-new-dot" />}
      </button>
      {open && <FilesDrawer taskId={taskId} projectId={projectId} files={files} seenAt={seenAtOpen} onClose={() => setOpen(false)} />}
    </>
  )
}

function FilesDrawer({ taskId, projectId, files, seenAt, onClose }: { taskId: string; projectId: string | null; files: Artifact[]; seenAt: number | null; onClose: () => void }) {
  const [query, setQuery] = useState("")
  const listing = useMemo(() => listFiles(files, query), [files, query])
  const gallery = useMemo(() => galleryOf(listing.ordered), [listing])
  const getGallery = useCallback(() => gallery, [gallery])
  // Marked only against an earlier look, like the chip's dot (isUnseen).
  const isNew = (f: TaskFile) => isUnseen(f, seenAt)
  const fresh = unseenCount(files, seenAt)

  return (
    <Modal
      size="lg"
      placement="sheet"
      title="Files"
      description={`${files.length} file${files.length === 1 ? "" : "s"} published by this task${fresh ? ` · ${fresh} new` : ""}`}
      onClose={onClose}
      // The drawer's own width (a phone's sheet, the desktop dialog) lays out the tiles and rows, not the window's.
      // Its padding alone follows the window, with the Modal header's above it.
      bodyClassName="@container scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-5"
    >
      {files.length >= FILTER_MIN && (
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // The first Esc clears the filter; the next one closes the drawer.
              if (e.key === "Escape" && query) {
                e.preventDefault()
                setQuery("")
              }
            }}
            placeholder="Filter files"
            aria-label="Filter files"
            // To a finger: 44px tall, and 16px text, which a phone doesn't zoom into.
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900 py-1.5 pr-9 pl-8 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-700 focus:outline-none pointer-coarse:min-h-11 pointer-coarse:pr-12 pointer-coarse:text-base"
          />
          {query && (
            <button type="button" onClick={() => setQuery("")} aria-label="Clear filter" className="absolute top-1/2 right-1 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-zinc-500 hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none pointer-coarse:right-0 pointer-coarse:h-11 pointer-coarse:w-11">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}
      {!listing.ordered.length && <p className="py-6 text-center text-sm text-zinc-500">No files match “{query}”.</p>}
      {listing.sections.map((s) => (
        <section key={s.key} className="space-y-2">
          {s.label && (
            <h3 className="text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
              {s.label} <span className="font-normal text-zinc-600">· {s.images.length + s.others.length}</span>
            </h3>
          )}
          {s.images.length > 0 && (
            <ul className="grid grid-cols-2 gap-2 @lg:grid-cols-3">
              {s.images.map((f) => (
                <li key={f.id}>
                  <ArtifactLink
                    artifact={f}
                    gallery={getGallery}
                    title={`${f.title} · ${formatSize(f.size)}`}
                    className="group flex h-full flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 hover:border-zinc-600 focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none"
                  >
                    <img src={thumbUrl(f.url, 640)} alt="" loading="lazy" decoding="async" className="aspect-video w-full shrink-0 bg-zinc-950 object-cover object-top" />
                    {/* The title gets the tile's whole width; what kind, how big and how old go under it. */}
                    <span className="block px-2 py-1.5 text-xs">
                      <span className="line-clamp-2 wrap-anywhere text-zinc-300 group-hover:text-zinc-100">
                        {isNew(f) && <NewMark />}
                        {shortTitle(f.title, s.label)}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-zinc-500">
                        {fileType(f)} · {formatSize(f.size)} · <TimeAgo ts={f.createdAt} />
                      </span>
                    </span>
                  </ArtifactLink>
                </li>
              ))}
            </ul>
          )}
          {s.others.length > 0 && (
            <ul className="divide-y divide-zinc-900 overflow-hidden rounded-lg border border-zinc-800/80">
              {s.others.map((f) => (
                <li key={f.id}>
                  <ArtifactLink
                    artifact={f}
                    gallery={getGallery}
                    className="flex items-start gap-2.5 px-3 py-2 text-sm hover:bg-zinc-900 focus-visible:bg-zinc-900 focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none focus-visible:ring-inset @lg:items-center pointer-coarse:min-h-11"
                  >
                    <span className="flex h-lh shrink-0 items-center">
                      <KindIcon kind={fileKind(f)} />
                    </span>
                    {/* Narrow: the title on up to two lines, its details under it. Wide: one line, details at the end. */}
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5 @lg:flex-row @lg:items-center @lg:gap-2.5">
                      <span className="line-clamp-2 min-w-0 wrap-anywhere text-zinc-200 @lg:line-clamp-1 @lg:flex-1">
                        {isNew(f) && <NewMark />}
                        {shortTitle(f.title, s.label)}
                      </span>
                      <span className="shrink-0 text-xs whitespace-nowrap text-zinc-500">
                        {fileType(f)} · {formatSize(f.size)} · <TimeAgo ts={f.createdAt} />
                      </span>
                    </span>
                  </ArtifactLink>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </Modal>
  )
}

/** Before a title: a dot for a file published since the list was last opened, and the word for a screen reader. */
const NewMark = () => (
  <>
    <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-sky-400 align-middle" title="New since you last looked" aria-hidden />
    <span className="sr-only">New: </span>
  </>
)

const KIND_ICON: Partial<Record<PreviewKind, typeof File>> = {
  image: FileImage,
  markdown: FileText,
  text: FileText,
  csv: FileText,
  pdf: FileText,
  html: FileCode,
  json: FileCode,
  video: Film,
  audio: Music,
}

export function KindIcon({ kind, className = "h-4 w-4" }: { kind: PreviewKind | null; className?: string }) {
  const Icon = (kind && KIND_ICON[kind]) || File
  return <Icon className={cx("shrink-0 text-zinc-500", className)} />
}

/** The transcript's "published X" event: a small file row, with a thumbnail for images. */
export const PublishedFile = memo(function PublishedFile({ artifactId, url, text }: { artifactId: string | undefined; url: string; text: string }) {
  const artifacts = useArtifacts()
  const a = artifactId ? artifacts.data?.find((x) => x.id === artifactId) : undefined
  const f: TaskFile = a ?? { id: artifactId ?? url, title: text.replace(/^Published artifact:\s*/, ""), filename: url.slice(url.lastIndexOf("/") + 1), mime: "", size: 0, url, createdAt: 0 }
  const image = isImageFile(f)
  return (
    <ArtifactLink
      artifact={{ projectId: null, taskId: null, ...f }}
      title={`Published ${f.title}`}
      // 44px to a finger (TAP_AREA); the margin keeps the areas of two wrapped rows of chips apart.
      className={cx(
        TAP_AREA,
        "inline-flex max-w-full items-center gap-2 rounded-md border border-zinc-800/80 bg-zinc-900/60 py-0.5 pr-2 pl-0.5 align-middle text-xs text-zinc-400 hover:border-zinc-700 hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none pointer-coarse:my-2",
      )}
    >
      {image ? (
        <img src={thumbUrl(f.url, 320)} alt="" loading="lazy" decoding="async" className="h-6 w-9 shrink-0 rounded-sm border border-zinc-800 bg-zinc-950 object-cover object-top" />
      ) : (
        <span className="grid h-6 w-6 shrink-0 place-items-center">
          <KindIcon kind={fileKind(f)} className="h-3.5 w-3.5" />
        </span>
      )}
      <span className="shrink-0 text-zinc-600">Published</span>
      <span className="min-w-0 truncate text-zinc-300">{f.title}</span>
      {f.size > 0 && (
        // Only where the transcript's column (ChatHistory's container) has the room, whatever the window's width.
        <span className="shrink-0 text-[11px] text-zinc-600 @max-md/history:hidden">
          {fileType(f)} · {formatSize(f.size)}
        </span>
      )}
    </ArtifactLink>
  )
})
