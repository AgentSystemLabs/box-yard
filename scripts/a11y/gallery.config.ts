// Development-only fixture entry, outside the production app's web root/build.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
export default defineConfig({ plugins: [react(), tailwindcss()], server: { host: '127.0.0.1', port: 4001, hmr: false, watch: null }, define: { __APP_VERSION__: '"fixture"', __APP_COMMIT__: '"fixture"' } })
