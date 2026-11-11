// Back-to-back "published" file notices as one compact card per task: the task, "published 6 files", then a strip of
// small thumbnails and titled chips for other files; "Show all 6" swaps the strip for every file as a link row.
// Every file opens the preview modal, and ←/→ step through the whole group. Grouping is lib/publishedNotices.ts.
import { memo, useId, useMemo, useState } from "react"
import { ChevronDown } from "lucide-react"
import { META_CHIP, TimeAgo, cx } from "./ui"
import { FileLink } from "./FileLink"
import { KindIcon } from "./TaskFiles"
import { NOTICE_CLASS, NoticeCard, NoticeLayout, NoticeProject } from "./ChatLine"
import { previewKind } from "../lib/filePreview"
import { thumbUrl } from "../../../shared/thumbs"
import { imagesFirst, previewGallery, publishedLabel, sameGroup, type PublishedFileRef, type PublishedGroup } from "../lib/publishedNotices"

/** Files shown before "+N more" (fewer in a narrow card), so the strip stays short. */
export const STRIP_MAX = 6
const STRIP_MAX_NARROW = 4

export const SLIM_TITLE_LINK = "font-medium text-zinc-200 hover:underline"

const kindOf = (f: PublishedFileRef) => previewKind({ url: f.url, name: f.filename })
const extOf = (f: PublishedFileRef) => {
  const dot = f.filename.lastIndexOf(".")
  return dot > 0 ? f.filename.slice(dot + 1).toUpperCase().slice(0, 5) : "FILE"
}

/**
 * A file in the strip, the same height whatever it is: an image is its thumbnail, any other file its icon and title.
 * `solo`: the card's only file, so an image shows its title too and nothing caps the title's width but the card.
 */
function Thumb({ f, gallery, solo, className }: { f: PublishedFileRef; gallery: () => ReturnType<typeof previewGallery>; solo?: boolean; className?: string }) {
  const kind = kindOf(f)
  const image = kind === "image"
  const titled = !image || solo
  return (
    <FileLink
      href={f.url}
      name={f.filename}
      fileTitle={f.title}
      gallery={gallery}
      title={f.title}
      aria-label={titled ? undefined : f.title}
      className={cx(
        "inline-flex h-11 max-w-full shrink-0 items-center overflow-hidden rounded-md border border-zinc-800 bg-zinc-950 text-xs text-zinc-300 hover:border-zinc-600 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none sm:h-7",
        className,
      )}
    >
      {image && <img src={thumbUrl(f.url, 320)} alt="" loading="lazy" decoding="async" className="h-full w-14 shrink-0 object-cover object-top sm:w-10" />}
      {titled && (
        <span className="inline-flex min-w-0 items-center gap-1 px-1.5">
          {!image && <KindIcon kind={kind} className="h-3 w-3" />}
          <span className={cx("truncate", !solo && "max-w-[9rem]")}>{f.title}</span>
        </span>
      )}
    </FileLink>
  )
}

/**
 * A NoticeLayout: the task on its own row, "box-yard · Captain · published 2 files" under it, then the files: a strip
 * (images first, then titled chips, "+2 more" for the rest), or once opened the whole list. The Show all / Hide toggle
 * ends the files' own first row either way, so it sits on what it opens and closes, never by the title.
 * `project` adds the task's project and Captain links (the Coordinator's card; the Captain tab is that project already).
 * `time` is the Captain tab's row: the time on the right of the meta line, and that tab's quieter title.
 */
function GroupBody({ group, time, project }: { group: PublishedGroup; time?: number; project?: boolean }) {
  const [open, setOpen] = useState(false)
  const listId = useId()
  const files = useMemo(() => imagesFirst(group.files), [group.files])
  const gallery = useMemo(() => previewGallery(files), [files])
  const getGallery = () => gallery
  const more = (n: number, className: string) => n > 0 && <span className={cx("whitespace-nowrap text-zinc-500", className)}>+{n} more</span>
  return (
    <div data-testid="published-group" data-count={files.length}>
      <NoticeLayout
        kind="artifact"
        title={group.taskTitle}
        taskId={group.taskId}
        project={project && group.taskId && <NoticeProject taskId={group.taskId} />}
        titleClassName={time !== undefined ? SLIM_TITLE_LINK : undefined}
        meta={
          <>
            {publishedLabel(files.length)}
            {time !== undefined && (
              <span className="float-right ml-2 text-[11px] text-zinc-600">
                <TimeAgo ts={time} />
              </span>
            )}
          </>
        }
      >
        <div data-testid="published-files" className="mt-1">
          <div data-testid="published-files-header" className="flex min-w-0 flex-wrap items-center gap-1.5">
            {open ? (
              <span className="min-w-0 flex-1 truncate text-zinc-500">{files.length} files</span>
            ) : (
              <>
                {/* A narrow card shows fewer files before "+N more". */}
                {files.slice(0, STRIP_MAX).map((f, i) => (
                  <Thumb key={f.id} f={f} gallery={getGallery} solo={files.length === 1} className={i >= STRIP_MAX_NARROW ? "@max-md:hidden" : undefined} />
                ))}
                {more(files.length - STRIP_MAX_NARROW, "@md:hidden")}
                {more(files.length - STRIP_MAX, "@max-md:hidden")}
              </>
            )}
            {/* One button in one place in both states, so it keeps the focus when it's pressed. */}
            {files.length > 1 && (
              <button
                type="button"
                aria-expanded={open}
                aria-controls={open ? listId : undefined}
                onClick={() => setOpen((o) => !o)}
                className={cx(META_CHIP, "ml-auto border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200")}
              >
                {open ? "Hide" : `Show all ${files.length}`}
                <ChevronDown className={cx("h-3 w-3 transition-transform", open && "rotate-180")} />
              </button>
            )}
          </div>
          {open && (
            <ul id={listId} className="mt-0.5 space-y-0.5">
              {files.map((f) => (
                <li key={f.id}>
                  <FileLink
                    href={f.url}
                    name={f.filename}
                    fileTitle={f.title}
                    gallery={getGallery}
                    className="-mx-1 flex min-h-11 items-center gap-1.5 rounded px-1 text-zinc-300 hover:bg-zinc-800/60 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none sm:min-h-0 sm:py-0.5"
                  >
                    {/* The icon stays on the first line of a title that wraps. */}
                    <span className="flex min-w-0 items-start gap-1.5">
                      <span className="flex h-lh shrink-0 items-center">
                        <KindIcon kind={kindOf(f)} className="h-3.5 w-3.5" />
                      </span>
                      <span className="min-w-0 wrap-anywhere">{f.title}</span>
                    </span>
                    {/* The file name only where the title still gets most of the row. */}
                    <span className="ml-auto shrink-0 pl-2 text-[10px] text-zinc-600 @max-md:hidden">{f.filename.length > 28 ? extOf(f) : f.filename}</span>
                  </FileLink>
                </li>
              ))}
            </ul>
          )}
        </div>
      </NoticeLayout>
    </div>
  )
}

/** The Coordinator chat's card: a notice card that opens the task when clicked outside its links. */
export const PublishedCard = memo(
  function PublishedCard({ group }: { group: PublishedGroup }) {
    const body = <GroupBody group={group} project />
    return (
      <div id={`chat-${group.id}`}>
        {group.taskId ? (
          <NoticeCard taskId={group.taskId}>
            {body}
          </NoticeCard>
        ) : (
          <div className={NOTICE_CLASS}>{body}</div>
        )}
      </div>
    )
  },
  (a, b) => sameGroup(a.group, b.group),
)

/** The Captain tab's slim form, with the newest file's time and its other rows' title (CaptainTab's NoticeRow). */
export const PublishedRow = memo(
  function PublishedRow({ group }: { group: PublishedGroup }) {
    return (
      <div id={`captain-${group.id}`} className="rounded-lg px-2 py-1.5 text-xs text-zinc-500 hover:bg-zinc-900/60">
        <GroupBody group={group} time={group.files.at(-1)!.createdAt} />
      </div>
    )
  },
  (a, b) => sameGroup(a.group, b.group),
)
