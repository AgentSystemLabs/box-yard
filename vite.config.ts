import { defineConfig, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { selfUrl } from "./server/bind"
import { precompress } from "./server/compress"

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

export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss(), preloadUiFont(), precompressBuild()],
  define: { __APP_VERSION__: JSON.stringify(version), __APP_COMMIT__: JSON.stringify(commit) },
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: api, changeOrigin: true },
      "/artifacts": { target: api, changeOrigin: true },
    },
  },
})
