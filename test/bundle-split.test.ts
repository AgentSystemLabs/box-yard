// The first load ships only what the first screen needs: Settings, a project's settings, the schedules panel, a task's
// panel, the first-run setup card, the file preview's viewer and the command palette's list are chunks of their own
// (components/LazyPart.tsx). One static import from first-load code (say useOpenSettings from SettingsDialog.tsx, or
// Row from it in a card) quietly pulls a surface back in, so build the real bundle and check.
import { describe, expect, it } from "vitest"
import path from "node:path"
import { build, type Rolldown } from "vite"

const root = path.resolve(import.meta.dirname, "..")

const LAZY = [
  "components/SettingsDialog.tsx",
  "components/ProjectView.tsx",
  "components/Schedules.tsx",
  "components/Identities.tsx",
  "components/Hooks.tsx",
  "components/UsageModal.tsx",
  "components/TaskSession.tsx",
  "components/Setup.tsx",
  "components/CredentialsSettings.tsx",
  "components/MoreLogins.tsx",
  "components/LoginLimits.tsx",
  "components/FilePreview.tsx",
  "components/Palette.tsx",
]

/**
 * What index.html loads before the app can paint (the entry and every chunk it imports), in minified bytes. It was
 * 1.47 MB before the setup card, a task's panel, the file preview's viewer and the palette's list left it, and 1.33 MB
 * after. Raise it on purpose, having looked at what grew.
 */
const FIRST_LOAD_BUDGET = 1_380_000
/** Vite's build.chunkSizeWarningLimit (500 kB, which it counts in thousands of bytes). */
const CHUNK_LIMIT = 500_000

// One build for every check here: it takes a few seconds.
let built: Promise<(Rolldown.OutputChunk | Rolldown.OutputAsset)[]> | undefined
function output() {
  built ??= (async () => {
    // Vitest sets NODE_ENV to "test", and a build follows it: React would come in its development build. Build what
    // `npm run build` ships.
    const env = process.env.NODE_ENV
    process.env.NODE_ENV = "production"
    try {
      const out = await build({ configFile: path.join(root, "vite.config.ts"), logLevel: "silent", build: { write: false, sourcemap: false } })
      return ((Array.isArray(out) ? out : [out]) as Rolldown.RolldownOutput[]).flatMap((o) => o.output)
    } finally {
      process.env.NODE_ENV = env
    }
  })()
  return built
}

async function chunks() {
  return (await output()).filter((c): c is Rolldown.OutputChunk => c.type === "chunk")
}

/** The chunks `from` loads with it: itself and everything it imports statically, all the way down. */
function closure(all: Rolldown.OutputChunk[], from: Rolldown.OutputChunk[]) {
  const byName = new Map(all.map((c) => [c.fileName, c]))
  const seen = new Map<string, Rolldown.OutputChunk>()
  const visit = (c: Rolldown.OutputChunk | undefined) => {
    if (!c || seen.has(c.fileName)) return
    seen.set(c.fileName, c)
    for (const dep of c.imports) visit(byName.get(dep))
  }
  from.forEach(visit)
  return [...seen.values()]
}

/** The entry plus everything it imports statically: what index.html loads before the app can paint. */
async function firstLoad() {
  const all = await chunks()
  return closure(all, all.filter((c) => c.isEntry))
}

const bytes = (c: Rolldown.OutputChunk) => Buffer.byteLength(c.code)

/** A text asset of the build (index.html, the stylesheet) by its file name. */
async function asset(match: RegExp) {
  const file = (await output()).find((a): a is Rolldown.OutputAsset => a.type === "asset" && match.test(a.fileName))
  expect(file, `no asset matches ${match}`).toBeDefined()
  return String(file!.source)
}

describe("web bundle", () => {
  it("keeps the surfaces that open on demand out of the first load, each loadable on its own", async () => {
    const all = await chunks()
    const firstModules = (await firstLoad()).flatMap((c) => c.moduleIds)
    const where = (file: string) => all.filter((c) => c.moduleIds.some((id) => id.endsWith(`web/src/${file}`)))

    for (const file of LAZY) {
      expect(firstModules.filter((id) => id.endsWith(`web/src/${file}`)), `${file} is in the first load`).toEqual([])
      expect(where(file).length, `${file} is in no chunk`).toBe(1)
    }
    // The Captain icon picker, its catalogue's names and search words, and the catalogue's components come when it's
    // opened (or a Captain shows an icon that isn't built in): the first screen draws Captains with shared/captainMark.ts.
    for (const file of ["web/src/components/CaptainIconPicker.tsx", "web/src/lib/captainIconCatalog.ts", "shared/captainIcons.ts"])
      expect(firstModules.filter((id) => id.endsWith(file)), `${file} is in the first load`).toEqual([])
    expect(firstModules.some((id) => id.endsWith("shared/captainMark.ts")), "shared/captainMark.ts is not in the first load").toBe(true)
    // Still in the first load: the small pieces every page uses to open them, and to wait for them.
    for (const file of [
      "components/SettingsHost.tsx",
      "components/SettingsBlocks.tsx",
      "components/LazyPart.tsx",
      "components/SetupReminder.tsx",
      "components/FilePreviewHost.tsx",
      "components/CommandPalette.tsx",
      "components/TaskPanelPending.tsx",
    ])
      expect(firstModules.some((id) => id.endsWith(`web/src/${file}`)), `${file} is not in the first load`).toBe(true)
    // The setup card's chunk, and all it loads with it, leaves the extra logins and their limits to Settings and Usage.
    const card = closure(all, where("components/Setup.tsx")).flatMap((c) => c.moduleIds)
    for (const file of ["components/MoreLogins.tsx", "components/LoginLimits.tsx"]) expect(card.filter((id) => id.endsWith(`web/src/${file}`)), `${file} loads with the setup card`).toEqual([])
  })

  it("keeps the first load within its budget and every chunk under Vite's size limit", async () => {
    const first = await firstLoad()
    const total = first.reduce((sum, c) => sum + bytes(c), 0)
    const sizes = first.map((c) => `${c.fileName} ${bytes(c)}`).join("\n")
    expect(total, `the first load is ${total} bytes:\n${sizes}`).toBeLessThanOrEqual(FIRST_LOAD_BUDGET)
    for (const c of await chunks()) expect(bytes(c), `${c.fileName} is over 500 kB`).toBeLessThanOrEqual(CHUNK_LIMIT)
  })

  // React (with TanStack Query and wouter) and Markdown are chunks of their own (vite.config.ts). With no app code in
  // them, or in what they import, an update to the app leaves their file names, so the browser keeps them cached.
  it("loads React and Markdown first, in chunks that hold and import no app code", async () => {
    const all = await chunks()
    const first = new Set((await firstLoad()).map((c) => c.fileName))
    const isApp = (id: string) => !id.includes("/node_modules/") && !id.startsWith("\0")
    for (const [name, lib] of [["react", "/react-dom/"], ["markdown", "/react-markdown/"]] as const) {
      const vendor = all.find((c) => c.name === name)
      expect(vendor, `no ${name} chunk`).toBeDefined()
      expect(first.has(vendor!.fileName), `${name} isn't in the first load`).toBe(true)
      expect(vendor!.moduleIds.some((id) => id.includes(lib)), `${lib} isn't in the ${name} chunk`).toBe(true)
      for (const c of closure(all, [vendor!])) expect(c.moduleIds.filter(isApp), `${c.fileName} (with ${name}) holds app code`).toEqual([])
    }
    // Each library in exactly one place.
    expect(all.filter((c) => c.moduleIds.some((id) => id.includes("/react-dom/"))).map((c) => c.name)).toEqual(["react"])
    expect(all.filter((c) => c.moduleIds.some((id) => id.includes("/micromark/"))).map((c) => c.name)).toEqual(["markdown"])
  })

  // The UI font (Inter) and the wordmark's (cut from Sora, scripts/wordmark-font.py) come with the app: no
  // font CDN. The UI font's latin file is preloaded, as the browser would only find it after the script rendered; the
  // wordmark's few letters ride inside the stylesheet, so it paints with the first frame.
  it("preloads the UI font and inlines the wordmark's", async () => {
    const html = await asset(/^index\.html$/)
    const css = await asset(/^assets\/index-[\w-]+\.css$/)
    const preloads = [...html.matchAll(/<link rel="preload"[^>]*as="font"[^>]*>/g)].map((m) => m[0])
    expect(preloads).toHaveLength(1)
    const href = preloads[0]!.match(/href="([^"]+)"/)![1]!
    expect(href).toMatch(/^\/assets\/inter-latin-wght-normal-[\w-]+\.woff2$/)
    // Fonts load in CORS mode, so a preload without crossorigin is fetched twice.
    expect(preloads[0]).toContain("crossorigin")
    // The stylesheet asks for the very file that's preloaded.
    expect(css).toContain(`url(${href})`)
    // That face holds the first paint's text until it's in (block), so the app never paints in a fallback that then
    // reflows into Inter. Every other face, upright and italic in each script, still comes, and swaps in: none is
    // preloaded, so blocking on one would hide text.
    const faces = [...css.matchAll(/@font-face\{([^}]*font-family:Inter Variable[^}]*)\}/g)].map((m) => m[1]!)
    expect(faces).toHaveLength(14)
    expect(faces.filter((f) => f.includes("font-style:italic"))).toHaveLength(7)
    const display = (face: string) => /font-display:(\w+)/.exec(face)?.[1]
    expect(faces.filter((f) => f.includes(`url(${href})`)).map(display)).toEqual(["block"])
    expect(faces.filter((f) => !f.includes(`url(${href})`)).map(display)).toEqual(Array(13).fill("swap"))
    expect(css).toMatch(/font-family:Box Yard Wordmark;src:url\(data:font\/woff2;base64,/)
    // The file holds only the SemiBold, so the face must say so: as a 400 face, the browser would draw a fake bold over it.
    expect(css).toMatch(/font-family:Box Yard Wordmark;[^}]*font-weight:600/)
    expect(html + css).not.toMatch(/fonts\.(googleapis|gstatic)\.com/)
  })
})
