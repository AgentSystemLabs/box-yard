// The file preview's dialog, mounted once in the app as <FilePreviewHost>: links open it through <FileLink> and
// lib/preview.ts, and `?preview=` opens it again on a reload or Back. What it shows (FilePreview.tsx: an image's
// lightbox, rendered markdown, frames, text and code, players) is a chunk of its own that comes the first time a file
// opens; the dialog, its Close, Esc and the file's name are here from the first frame.
import type { ReactNode } from "react"
import { useSearchParams } from "wouter"
import { ExternalLink, FileWarning, RotateCw } from "lucide-react"
import { useArtifacts } from "../lib/queries"
import { fileNameOf, isTextKind, parsePreviewKey, previewKey, previewKind, type PreviewItem, type PreviewKind } from "../lib/filePreview"
import { PREVIEW_PARAM, closePreview, usePreviewState } from "../lib/preview"
import { DismissButton, Modal, type ModalSize } from "./Modal"
import { LoadFailed, lazyPart } from "./LazyPart"
import { Loading } from "./Loading"
import { NewTabLink, cx } from "./ui"
import type { Artifact } from "../../../shared/types"

/** One file, or one of a gallery (`position`: where it is, of how many; `noun`: what the gallery steps through). */
export type PreviewProps = { item: PreviewItem; position: [number, number] | null; noun: "image" | "file" }

/** The preview's top row: the file's name, its view controls and actions, and Close. */
export const PREVIEW_HEADER =
  "flex shrink-0 items-center gap-1 border-b border-zinc-900 py-2 pr-2 pl-4 @[30rem]/preview:min-h-14 @[30rem]/preview:gap-2 @[30rem]/preview:pr-3 @[30rem]/preview:pl-5"

// A preview is opened, not on every visit, so it stays out of the background warm-up.
const FilePreview = lazyPart<PreviewProps>(() => import("./FilePreview").then((m) => m.FilePreview), {
  Loading: ({ item }) => (
    <PreviewFrame item={item}>
      <Loading kind="field" label="Loading file" className="absolute inset-4 h-auto! sm:h-auto!" />
    </PreviewFrame>
  ),
  Failed: ({ item }) => (
    <PreviewFrame item={item}>
      <div className="px-4 py-5 @[30rem]/preview:px-5">
        <LoadFailed />
      </div>
    </PreviewFrame>
  ),
  warm: false,
})

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
  const position: [number, number] | null = gallery ? [gallery.index + 1, gallery.items.length] : null
  const kind = previewKind(item)
  return (
    <Modal
      size={position ? "full" : kind ? SIZE[kind] : "md"}
      label={item.name || fileNameOf(item.url)}
      onClose={closePreview}
      // sm: is Modal's own switch from a phone's full screen to a dialog, so the dialog's height goes with it.
      className={cx((position || (kind && TALL.includes(kind))) && "sm:h-[85vh]", !position && kind && isTextKind(kind) && "sm:max-h-[85vh]")}
      bodyClassName="@container/preview relative flex min-h-0 flex-1 flex-col"
    >
      <FilePreview item={item} position={position} noun={gallery && gallery.items.some((g) => previewKind(g) !== "image") ? "file" : "image"} />
    </Modal>
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

/** The dialog while its viewer's chunk comes in (or couldn't): the file's name and Close where the viewer has them. */
function PreviewFrame({ item, children }: { item: PreviewItem; children: ReactNode }) {
  const heading = item.title || item.name || fileNameOf(item.url)
  return (
    <>
      <header className={PREVIEW_HEADER}>
        <h2 className="line-clamp-2 min-w-0 flex-1 text-sm font-semibold wrap-anywhere text-zinc-50" title={heading}>
          {heading}
        </h2>
        <DismissButton kind="close" onClick={closePreview} />
      </header>
      <div className="relative min-h-40 flex-1">{children}</div>
    </>
  )
}

const PROBLEM_ACTION =
  "inline-flex items-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700 focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none pointer-coarse:min-h-11"

/**
 * A file that can't be shown, said to a screen reader as it appears, with what can still be done.
 * `onRetry`: loading it failed, so loading it again may work. `url`: the browser may still open it. A deleted file
 * gets neither. `dark`: on the image stage, which is dark in both themes, so the text is light in both.
 */
export function Problem({ message, url, onRetry, dark }: { message: string; url?: string; onRetry?: () => void; dark?: boolean }) {
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
