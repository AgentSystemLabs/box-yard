import { AlertTriangle, FileText, Loader2, RotateCw, X } from "lucide-react"
import { attachmentUrl, formatSize, isImage } from "./Attachments"
import { FileLink, PREVIEW_GROUP } from "./FileLink"
import { cx } from "./ui"
import { uploadProblem, type PendingFile } from "../lib/pendingUploads"

/**
 * On a touch screen, Remove (drawn 20px) takes a 44px square. On a thumbnail it leans out into the tray's 16px top
 * padding and row gap and its 8px column gap, so it takes only the corner and a tap on the middle opens the preview.
 */
const FINGER_THUMB = "pointer-coarse:before:absolute pointer-coarse:before:-inset-x-3 pointer-coarse:before:-top-5 pointer-coarse:before:-bottom-1"
const FINGER_CHIP = "pointer-coarse:before:absolute pointer-coarse:before:-inset-3"

const RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yard-500"

const THUMB = "h-14 w-14 rounded-md object-cover pointer-coarse:h-16 pointer-coarse:w-16"

/**
 * The files in a Composer waiting for the send: image thumbnails and chips for other files. Each shows its upload's
 * progress, opens the preview once uploaded, and has a Remove (which cancels an upload in flight). A failed upload offers
 * Retry, and the line under the tray says what failed and that it holds the send.
 */
export function ComposerAttachments({ files, onRemove, onRetry }: { files: readonly PendingFile[]; onRemove: (key: number) => void; onRetry: (key: number) => void }) {
  const problem = uploadProblem(files)
  return (
    <>
      {files.length > 0 && (
        <ul aria-label="Attachments" className="flex flex-wrap items-center gap-2 px-3 pt-3 pointer-coarse:gap-y-4 pointer-coarse:pt-4" {...PREVIEW_GROUP}>
          {files.map((f) => {
            // A restored draft's image has no object URL: show the uploaded copy.
            const thumb = f.preview ?? (f.attachment && isImage(f.mime) ? attachmentUrl(f.attachment) : null)
            const title = f.error ?? `${f.name} · ${formatSize(f.size)}`
            const remove = (
              <button
                type="button"
                onClick={() => onRemove(f.key)}
                aria-label={f.status === "uploading" ? `Cancel uploading ${f.name}` : `Remove ${f.name}`}
                title={f.status === "uploading" ? "Cancel upload" : "Remove"}
                className={cx(
                  RING,
                  "grid h-5 w-5 shrink-0 place-items-center rounded-full bg-zinc-800 text-zinc-300 ring-1 ring-zinc-950 hover:bg-zinc-700 hover:text-zinc-100",
                  // In a chip, margins keep the finger area off the name and inside the chip's edge.
                  thumb ? cx(FINGER_THUMB, "absolute top-1 right-1") : cx(FINGER_CHIP, "relative mr-1.5 pointer-coarse:mx-1.5 pointer-coarse:mr-3"),
                )}
              >
                <X className="h-3 w-3" />
              </button>
            )
            return thumb ? (
              <li key={f.key} data-attachment title={title} className="relative">
                {f.status === "done" && f.attachment ? (
                  <FileLink
                    href={attachmentUrl(f.attachment)}
                    name={f.name}
                    size={f.size}
                    mime={f.mime}
                    className={cx(RING, "block rounded-lg border border-zinc-800 bg-zinc-950 p-0.5 hover:border-zinc-700")}
                  >
                    <img src={thumb} alt={f.name} className={THUMB} />
                  </FileLink>
                ) : (
                  <div className={cx("relative rounded-lg border bg-zinc-950 p-0.5", f.status === "error" ? "border-red-900/60" : "border-zinc-800")}>
                    <img src={thumb} alt={f.name} className={cx(THUMB, "opacity-40")} />
                    {f.status === "uploading" ? (
                      <div className="absolute inset-0.5 grid place-items-center text-xs font-semibold text-zinc-100 tabular-nums">
                        {f.progress === undefined ? <Loader2 className="h-4 w-4 motion-safe:animate-spin" /> : `${f.progress}%`}
                        <UploadBar file={f} className="absolute inset-x-1.5 bottom-1.5" />
                      </div>
                    ) : f.file ? (
                      <button
                        type="button"
                        onClick={() => onRetry(f.key)}
                        aria-label={`Retry uploading ${f.name}`}
                        className={cx(RING, "absolute inset-0.5 flex flex-col items-center justify-center gap-0.5 rounded-md bg-red-950/50 text-[11px] font-medium text-red-200 hover:bg-red-950/30")}
                      >
                        <RotateCw className="h-4 w-4" />
                        Retry
                      </button>
                    ) : (
                      <div className="absolute inset-0.5 grid place-items-center rounded-md bg-red-950/50 text-red-300">
                        <AlertTriangle className="h-4 w-4" />
                      </div>
                    )}
                  </div>
                )}
                {remove}
              </li>
            ) : (
              <li
                key={f.key}
                data-attachment
                title={title}
                className={cx(
                  "relative flex min-h-8 max-w-full items-center gap-1.5 rounded-lg border bg-zinc-950 text-xs pointer-coarse:min-h-11",
                  f.status === "error" ? "border-red-900/60 text-red-300" : "border-zinc-800 text-zinc-300",
                )}
              >
                {f.status === "done" && f.attachment ? (
                  <FileLink
                    href={attachmentUrl(f.attachment)}
                    name={f.name}
                    size={f.size}
                    mime={f.mime}
                    className={cx(RING, "flex min-w-0 items-center gap-1.5 self-stretch rounded-l-lg py-1 pl-2 hover:text-zinc-100")}
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                    <span className="max-w-[10rem] truncate">{f.name}</span>
                    <span className="shrink-0 text-zinc-600">{formatSize(f.size)}</span>
                  </FileLink>
                ) : (
                  <span className="flex min-w-0 items-center gap-1.5 py-1 pl-2">
                    {f.status === "error" ? (
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    ) : f.progress === undefined ? (
                      <Loader2 className="h-3.5 w-3.5 shrink-0 text-zinc-500 motion-safe:animate-spin" />
                    ) : (
                      <FileText className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                    )}
                    <span className="max-w-[10rem] truncate">{f.name}</span>
                    <span className="shrink-0 text-zinc-600 tabular-nums">{f.status === "uploading" && f.progress !== undefined ? `${f.progress}%` : formatSize(f.size)}</span>
                  </span>
                )}
                {f.status === "error" && f.file && (
                  <button
                    type="button"
                    onClick={() => onRetry(f.key)}
                    aria-label={`Retry uploading ${f.name}`}
                    className={cx(RING, "flex h-7 shrink-0 items-center gap-1 rounded px-1.5 font-medium text-red-200 hover:bg-red-950/40 pointer-coarse:h-11")}
                  >
                    <RotateCw className="h-3.5 w-3.5" />
                    Retry
                  </button>
                )}
                {remove}
                {f.status === "uploading" && <UploadBar file={f} className="absolute inset-x-1 bottom-0.5" />}
              </li>
            )
          })}
        </ul>
      )}
      {/* Always rendered, so a screen reader announces a failure as it lands (even an oversized file's, which fails at once). */}
      <div aria-live="polite" data-testid="upload-problem" className="px-3 text-xs">
        {problem && (
          <div className="pt-1.5">
            {problem.errors.map((error, i) => (
              <p key={i} className="text-red-400 wrap-anywhere">
                {error}
              </p>
            ))}
            <p className="text-zinc-400">{problem.fix}</p>
          </div>
        )}
      </div>
    </>
  )
}

/** A thin bar of how much of the file is sent; empty until the browser reports progress. */
function UploadBar({ file, className }: { file: PendingFile; className: string }) {
  return (
    <div
      role="progressbar"
      aria-label={`Uploading ${file.name}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={file.progress}
      className={cx("h-1 overflow-hidden rounded-full bg-zinc-800", className)}
    >
      <div className="h-full bg-yard-400" style={{ width: `${file.progress ?? 0}%` }} />
    </div>
  )
}
