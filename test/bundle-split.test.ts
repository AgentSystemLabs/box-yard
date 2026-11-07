// The first load ships only what the first screen needs: Settings, a project's settings and the schedules panel are
// chunks of their own (components/LazyPart.tsx). One static import from first-load code (say useOpenSettings from
// SettingsDialog.tsx, or Row from it in a card) quietly pulls a surface back in, so build the real bundle and check.
import { describe, expect, it } from "vitest"
import path from "node:path"
import { build, type Rolldown } from "vite"

const root = path.resolve(import.meta.dirname, "..")

const LAZY = ["components/SettingsDialog.tsx", "components/ProjectView.tsx", "components/Schedules.tsx", "components/Identities.tsx", "components/Hooks.tsx", "components/UsageModal.tsx"]

// One build for every check here: it takes a few seconds.
let built: Promise<(Rolldown.OutputChunk | Rolldown.OutputAsset)[]> | undefined
function output() {
  built ??= build({ configFile: path.join(root, "vite.config.ts"), logLevel: "silent", build: { write: false, sourcemap: false } }).then((out) =>
    ((Array.isArray(out) ? out : [out]) as Rolldown.RolldownOutput[]).flatMap((o) => o.output),
  )
  return built
}

async function chunks() {
  return (await output()).filter((c): c is Rolldown.OutputChunk => c.type === "chunk")
}

/** A text asset of the build (index.html, the stylesheet) by its file name. */
async function asset(match: RegExp) {
  const file = (await output()).find((a): a is Rolldown.OutputAsset => a.type === "asset" && match.test(a.fileName))
  expect(file, `no asset matches ${match}`).toBeDefined()
  return String(file!.source)
}

describe("web bundle", () => {
  it("keeps Settings, project settings and schedules out of the first load, each loadable on its own", async () => {
    const all = await chunks()
    const byName = new Map(all.map((c) => [c.fileName, c]))
    // The entry plus everything it imports statically: what index.html loads before the app can paint.
    const first = new Set<string>()
    const visit = (name: string) => {
      if (first.has(name)) return
      first.add(name)
      for (const dep of byName.get(name)?.imports ?? []) visit(dep)
    }
    for (const c of all) if (c.isEntry) visit(c.fileName)
    const firstModules = [...first].flatMap((name) => byName.get(name)?.moduleIds ?? [])
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
    // Still in the first load: the small pieces every page uses to open them.
    for (const file of ["components/SettingsHost.tsx", "components/SettingsBlocks.tsx", "components/LazyPart.tsx"])
      expect(firstModules.some((id) => id.endsWith(`web/src/${file}`)), `${file} is not in the first load`).toBe(true)
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
    expect(css).toMatch(/font-family:Box Yard Wordmark;src:url\(data:font\/woff2;base64,/)
    // The file holds only the SemiBold, so the face must say so: as a 400 face, the browser would draw a fake bold over it.
    expect(css).toMatch(/font-family:Box Yard Wordmark;[^}]*font-weight:600/)
    expect(html + css).not.toMatch(/fonts\.(googleapis|gstatic)\.com/)
  })
})
