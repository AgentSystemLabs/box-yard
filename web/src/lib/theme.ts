// Only this browser's theme preference is saved. Conversation data stays in memory.
import { useSyncExternalStore } from "react"

export type ThemePreference = "light" | "dark" | "system"
export const THEME_KEY = "boxyard:theme"
export const parseTheme = (raw: string | null): ThemePreference => raw === "light" || raw === "dark" ? raw : "system"
export const resolveTheme = (preference: ThemePreference, systemDark: boolean) => preference === "system" ? (systemDark ? "dark" : "light") : preference

function readTheme(): ThemePreference {
  try { return parseTheme(localStorage.getItem(THEME_KEY)) } catch { return "system" }
}

let preference = readTheme()
let media: MediaQueryList | undefined
const listeners = new Set<() => void>()
const getTheme = () => preference
const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
export const useTheme = () => useSyncExternalStore(subscribe, getTheme, getTheme)

function applyTheme() {
  const theme = resolveTheme(preference, media?.matches ?? true)
  document.documentElement.classList.toggle("dark", theme === "dark")
  document.documentElement.style.colorScheme = theme
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#09090b" : "#ffffff")
}

export function setTheme(next: ThemePreference) {
  preference = next
  try { localStorage.setItem(THEME_KEY, next) } catch {}
  applyTheme()
  listeners.forEach((fn) => fn())
}

/** The head script paints first; this keeps it current as the OS or another tab changes. */
export function installTheme() {
  preference = readTheme()
  media = window.matchMedia?.("(prefers-color-scheme: dark)")
  const systemChanged = () => { if (preference === "system") applyTheme() }
  const stored = (e: StorageEvent) => {
    if (e.key !== null && e.key !== THEME_KEY) return
    preference = readTheme()
    applyTheme()
    listeners.forEach((fn) => fn())
  }
  media?.addEventListener("change", systemChanged)
  window.addEventListener("storage", stored)
  applyTheme()
  return () => {
    media?.removeEventListener("change", systemChanged)
    window.removeEventListener("storage", stored)
  }
}
