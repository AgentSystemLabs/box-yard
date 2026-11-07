// A project's own icon (Project settings › General › Icon): an image Cody uploads to show instead of its coloured
// letter wherever the app draws the project. The server keeps it in its data dir (server/projectIcons.ts) and names
// its file by a hash of its bytes, so the URL changes with the image and a browser never shows an old one.

/** The most an icon upload may be, before the server shrinks it. */
export const PROJECT_ICON_MAX_BYTES = 1024 * 1024

/** What the file picker offers: the types the server takes (it checks the bytes, not these). */
export const PROJECT_ICON_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml,.png,.jpg,.jpeg,.webp,.gif,.svg"

/** Said wherever the types are listed. */
export const PROJECT_ICON_TYPES = "PNG, JPG, WebP, GIF or SVG"

/** A stored icon's file name (`<hash>.<ext>`, projects.icon). */
export const PROJECT_ICON_FILE = /^[a-f0-9]{12}\.(?:png|jpg|webp|gif|svg)$/

/** Where the app loads `icon` (projects.icon) from: `?v=` is its hash, so a new icon is a new URL. */
export const projectIconUrl = (projectId: string, icon: string) => `/api/projects/${encodeURIComponent(projectId)}/icon?v=${icon.replace(/\..*$/, "")}`
