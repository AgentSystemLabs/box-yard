import { defineConfig, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { selfUrl } from "./server/bind.ts"
import { precompress } from "./server/compress.ts"

// The API server listens on 127.0.0.1 with no password (server/bind.ts), so don't let "localhost" pick ::1.
const api = selfUrl(process.env.HOST ?? "127.0.0.1", Number(process.env.PORT ?? 3000))

// Shown in Settings > About. The commit is best effort: Docker builds may have no .git.
const version = (JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string }).version
let commit = ""
try {
  commit = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim()
} catch {}

/** Writes .br/.gz copies of the built text files, which the server sends as they are (server/webApp.ts). */
function precompressBuild(): Plugin {
  let outDir = ""
  return {
    name: "precompress",
    apply: "build",
    // A build kept in memory (write: false, as test/bundle-split.test.ts does) leaves nothing on disk to compress.
    configResolved: (config) => void (outDir = config.build.write ? resolve(config.root, config.build.outDir) : ""),
    closeBundle: async () => void (outDir && (await precompress(outDir))),
  }
}

/**
 * Preloads the UI font's latin file (styles.css): the browser only asks for a font once text needs it, after the
 * script has rendered, so without this the first screen paints in a fallback and reflows when Inter arrives.
 */
function preloadUiFont(): Plugin {
  return {
    name: "preload-ui-font",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler: (_html, { bundle }) =>
        Object.keys(bundle ?? {})
          .filter((file) => /\/inter-latin-wght-normal-[\w-]+\.woff2$/.test(file))
          .map((file) => ({ tag: "link", attrs: { rel: "preload", href: `/${file}`, as: "font", type: "font/woff2", crossorigin: "" }, injectTo: "head" as const })),
    },
  }
}

/**
 * The preloaded face, Inter's upright latin, holds the first paint's text back until it's in (`font-display: block`
 * instead of fontsource's `swap`), so the app never paints in a fallback that reflows into Inter. Preloaded with the
 * page, it's in before the script first renders on any usual connection. Slower than the browser's block period
 * (about 3 s), the text shows in the fallback and swaps to Inter when it lands; a failed request shows the fallback
 * at once. Every other face (italic, other scripts) isn't preloaded, so it keeps `swap` rather than hide text.
 */
function blockUiFont(): Plugin {
  const face = /(@font-face\s*\{[^}]*?font-display:\s*)swap(;[^}]*\/inter-latin-wght-normal\.woff2[^}]*\})/
  return {
    name: "block-ui-font",
    enforce: "pre",
    transform: {
      filter: { id: /[\\/]@fontsource-variable[\\/]inter[\\/]wght\.css(\?|$)/ },
      handler(css) {
        if (!face.test(css)) this.error("Inter's latin @font-face (inter-latin-wght-normal.woff2, font-display: swap) is no longer in wght.css")
        return css.replace(face, "$1block$2")
      },
    },
  }
}

/**
 * Libraries the first screen needs, in chunks of their own: they change far less often than the app, so an update
 * leaves them cached, and the app's own code stays under the 500 kB a chunk. Markdown takes its parser's whole tree
 * (react-markdown's and remark-gfm's dependencies come with them). The icons are those the first load draws (`$initial`),
 * with Box Yard's own two: an icon only a lazy part uses stays in that part's chunk.
 */
const CHUNK_GROUPS = [
  { name: "react", test: /[\\/]node_modules[\\/](react|react-dom|scheduler|@tanstack[\\/](react-query|query-core)|wouter)[\\/]/, priority: 2 },
  { name: "markdown", test: /[\\/]node_modules[\\/](react-markdown|remark-gfm)[\\/]/, priority: 1 },
  { name: "icons", test: /[\\/]node_modules[\\/]lucide-react[\\/]|[\\/]components[\\/]ShipIcons\.tsx$/, tags: ["$initial" as const] },
]

export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss(), blockUiFont(), preloadUiFont(), precompressBuild()],
  define: { __APP_VERSION__: JSON.stringify(version), __APP_COMMIT__: JSON.stringify(commit) },
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: { groups: CHUNK_GROUPS },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: api, changeOrigin: true },
      "/artifacts": { target: api, changeOrigin: true },
    },
  },
})
