import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { App } from "./App"
import { ApiError } from "./lib/api"
import { adoptEarlyStart } from "./lib/boot"
import { seedBoot } from "./lib/bootSeed"
import { keys } from "./lib/queries"
import { installPageGuards } from "./lib/resume"
import { installTapDebug } from "./lib/tapDebug"
import { LIVE_QUERY_DEFAULTS } from "./lib/liveQueries"
import { installTheme } from "./lib/theme"
import "@fontsource-variable/inter/wght.css"
import "@fontsource-variable/inter/wght-italic.css"
import "./styles.css"

installTheme()

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Live updates arrive over SSE, so data stays fresh without refetching (lib/liveQueries.ts says which).
      ...LIVE_QUERY_DEFAULTS,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 3,
    },
    mutations: { retry: 0 },
  },
})

// What index.html already asked for: the first queries take it instead of asking again.
adoptEarlyStart({ me: (data) => queryClient.setQueryData(keys.me, data), boot: (payload) => seedBoot(queryClient, payload) })
// Phones: the document scroll goes back after the keyboard and on resume; two fingers held still report what's on top.
installPageGuards()
installTapDebug()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
