// Back-to-back "published" file notices as one compact card per task: the task, "published 6 files", then a strip of
// small thumbnails and titled chips for other files, ending in "+3 more"; that one button swaps the strip for every
// file as a link row, and "Hide" swaps it back. Every file opens the preview modal, and ←/→ step through the whole
// group, in the order of the task's Files drawer. Grouping and order are lib/publishedNotices.ts.
import { memo, useId, useMemo, useState } from "react"
import { ChevronDown } from "lucide-react"
import { TimeAgo, cx } from "./ui"
import { FileLink } from "./FileLink"
import { KindIcon } from "./TaskFiles"
import { NOTICE_CLASS, NoticeCard, NoticeLayout, NoticeProject } from "./ChatLine"
import { previewKind } from "../lib/filePreview"
import { thumbUrl } from "../../../shared/thumbs"
import { drawerOrder, previewGallery, publishedLabel, sameGroup, type PublishedFileRef, type PublishedGroup } from "../lib/publishedNotices"

/** Files shown before "+N more", so the strip stays short. A narrow card (a phone) shows three, to fit one row. */
export const STRIP_MAX = 6

export const SLIM_TITLE_LINK = "font-medium text-zinc-200 hover:underline"

const kindOf = (f: PublishedFileRef) => previewKind({ url: f.url, name: f.filename })
const extOf = (f: PublishedFileRef) => {
  const dot = f.filename.lastIndexOf(".")
  return dot > 0 ? f.filename.slice(dot + 1).toUpperCase().slice(0, 5) : "FILE"
}

/** How many files a narrow card's strip shows: `max`, or one fewer when all of them would be titled chips, which are wide. */
function fit(files: readonly PublishedFileRef[], max: number): number {
  const first = files.slice(0, max)
  return first.length === max && max > 1 && first.every((f) => kindOf(f) !== "image") ? max - 1 : first.length
}

/**
 * A file in the strip, the same height whatever it is (28px, 44px to a finger): an image is its thumbnail, any other
 * file its icon and title. In a narrow card a title gives way before the row wraps.
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
        "inline-flex h-7 max-w-full shrink-0 items-center overflow-hidden rounded-md border border-zinc-800 bg-zinc-950 text-xs text-zinc-300 hover:border-zinc-600 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none pointer-coarse:h-11",
        titled && "@max-md:max-w-max @max-md:min-w-0 @max-md:shrink @max-md:grow @max-md:basis-14",
        className,
      )}
    >
      {image && <img src={thumbUrl(f.url, 320)} alt="" loading="lazy" decoding="async" className="h-full w-10 shrink-0 object-cover object-top pointer-coarse:w-14" />}
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
 * (thumbnails and titled chips) that ends in the card's one toggle, "+2 more"; once opened, the whole list under
 * "Hide". The toggle is one button in both states, so it keeps the focus.
 * `project` adds the task's project and Captain links (the Coordinator's card; the Captain tab is that project already).
 * `time` is the Captain tab's row: the time on the right of the meta line, and that tab's quieter title.
 */
function GroupBody({ group, time, project }: { group: PublishedGroup; time?: number; project?: boolean }) {
  const [open, setOpen] = useState(false)
  const listId = useId()
  const files = useMemo(() => drawerOrder(group.files), [group.files])
  const gallery = useMemo(() => previewGallery(files), [files])
  const getGallery = () => gallery
  // The strip by the card's width (a phone's, a 320px phone's): each shows what fits one row with the toggle.
  const small = fit(files, 3)
  const tiny = fit(files, 2)
  /** What the toggle says while closed: how many files the strip holds back, or that there is a list. */
  const more = (shown: number) => (files.length > shown ? `+${files.length - shown} more` : "Show list")
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
              <span className="flex-1" />
            ) : (
              files.slice(0, STRIP_MAX).map((f, i) => <Thumb key={f.id} f={f} gallery={getGallery} solo={files.length === 1} className={cx(i >= small && "@max-md:hidden", i >= tiny && "@max-[18rem]:hidden")} />)
            )}
            {files.length > 1 && (
              <button
                type="button"
                aria-expanded={open}
                aria-controls={open ? listId : undefined}
                title={open ? undefined : `Show all ${files.length} files`}
                onClick={() => setOpen((o) => !o)}
                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-zinc-800 px-1.5 text-xs font-medium whitespace-nowrap text-zinc-400 hover:border-zinc-700 hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none pointer-coarse:h-11 pointer-coarse:px-2"
              >
                {open ? (
                  "Hide"
                ) : (
                  <>
                    {/* A narrower card shows fewer files, so it has more to add. */}
                    <span className="@[18rem]:hidden">{more(tiny)}</span>
                    <span className="@max-[18rem]:hidden @md:hidden">{more(small)}</span>
                    <span className="@max-md:hidden">{more(STRIP_MAX)}</span>
                  </>
                )}
                <ChevronDown className={cx("h-3 w-3", open && "rotate-180")} />
              </button>
            )}
          </div>
          {open && (
            <ul id={listId} className="mt-0.5 space-y-0.5">
              {files.map((f) => {
                const kind = kindOf(f)
                return (
                  <li key={f.id}>
                    <FileLink
                      href={f.url}
                      name={f.filename}
                      fileTitle={f.title}
                      gallery={getGallery}
                      className="-mx-1 flex items-center gap-2 rounded px-1 py-0.5 text-zinc-300 hover:bg-zinc-800/60 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none pointer-coarse:min-h-11"
                    >
                      {/* A thumbnail's column for every row, so the titles line up. */}
                      {kind === "image" ? (
                        <img src={thumbUrl(f.url, 320)} alt="" loading="lazy" decoding="async" className="h-6 w-9 shrink-0 rounded-sm border border-zinc-800 bg-zinc-950 object-cover object-top" />
                      ) : (
                        <span className="grid h-6 w-9 shrink-0 place-items-center">
                          <KindIcon kind={kind} className="h-3.5 w-3.5" />
                        </span>
                      )}
                      <span className="min-w-0 wrap-anywhere">{f.title}</span>
                      {/* The file name only where the title still gets most of the row. */}
                      <span className="ml-auto shrink-0 pl-2 text-[11px] text-zinc-600 @max-md:hidden">{f.filename.length > 28 ? extOf(f) : f.filename}</span>
                    </FileLink>
                  </li>
                )
              })}
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
