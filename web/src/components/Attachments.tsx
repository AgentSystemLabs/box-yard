import { FileText } from "lucide-react"
import { FileLink, PREVIEW_GROUP } from "./FileLink"
import type { Attachment } from "../../../shared/types"
import { thumbUrl } from "../../../shared/thumbs"

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export const isImage = (mime: string) => mime.startsWith("image/") && mime !== "image/svg+xml"

export const attachmentUrl = (f: Pick<Attachment, "id" | "name">) => `/api/uploads/${f.id}/${encodeURIComponent(f.name)}`

/**
 * An attached image's thumbnail box, border included: what its max-w (192 px) and max-h (128 px) classes give once
 * it loads, but known before, so nothing below it moves. Null when the server didn't know the image's size.
 */
export function thumbBox(f: Pick<Attachment, "width" | "height">, maxWidth = 192, maxHeight = 128, border = 2): { width: number; height: number } | null {
  if (!f.width || !f.height) return null
  const scale = Math.min(1, (maxWidth - border) / f.width, (maxHeight - border) / f.height)
  return { width: Math.max(1, Math.round(f.width * scale)) + border, height: Math.max(1, Math.round(f.height * scale)) + border }
}

/**
 * Attachments on a sent message: image thumbnails and chips for other files. A click opens the preview. A thumbnail
 * is the server's small copy, sized up front when the server knows the image's size, so the chat doesn't jump.
 */
export function AttachmentList({ files }: { files: unknown }) {
  if (!Array.isArray(files) || !files.length) return null
  return (
    <div className="mt-1.5 flex flex-wrap gap-2" {...PREVIEW_GROUP}>
      {(files as Attachment[]).map((f) => {
        const url = attachmentUrl(f)
        const box = thumbBox(f)
        return isImage(f.mime) ? (
          <FileLink key={f.id} href={url} name={f.name} size={f.size} mime={f.mime} title={`${f.name} · ${formatSize(f.size)}`}>
            <img
              src={thumbUrl(url, 640)}
              alt={f.name}
              width={box?.width}
              height={box?.height}
              loading="lazy"
              decoding="async"
              className="max-h-32 max-w-[12rem] rounded-lg border border-zinc-800 object-cover"
            />
          </FileLink>
        ) : (
          <FileLink
            key={f.id}
            href={url}
            name={f.name}
            size={f.size}
            mime={f.mime}
            className="flex max-w-[14rem] items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-300 hover:border-zinc-700"
          >
            <FileText className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
            <span className="truncate">{f.name}</span>
            <span className="shrink-0 text-zinc-600">{formatSize(f.size)}</span>
          </FileLink>
        )
      })}
    </div>
  )
}
