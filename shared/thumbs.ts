// Thumbnails of the images Box Yard hosts (uploads and artifacts). `?w=` on a hosted image's URL asks the server
// for a WebP at most that wide (server/thumbs.ts), so a 36 px file chip doesn't download and decode a 12 MP photo.

/** The only widths the server makes, so its thumbnail cache stays small: chips and strips, cards, inline images. */
export const THUMB_WIDTHS = [320, 640, 1280] as const
export type ThumbWidth = (typeof THUMB_WIDTHS)[number]

/** Image types the server shrinks. Anything else (an animated GIF, an SVG) is served as it is. */
export const THUMB_MIMES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp", "image/avif"])

const HOSTED_IMAGE = /^\/(?:artifacts|api\/uploads)\/[^/?#]+\/[^/?#]+\.(?:png|jpe?g|webp|avif)$/i

/** A hosted image's thumbnail URL at `width`, or `url` itself for anything the server can't shrink. */
export function thumbUrl(url: string, width: ThumbWidth): string {
  return HOSTED_IMAGE.test(url) ? `${url}?w=${width}` : url
}
