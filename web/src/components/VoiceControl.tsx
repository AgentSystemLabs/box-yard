import { useEffect } from "react"
import { Volume2, VolumeX } from "lucide-react"
import { toggleVoice, unlockVoice, useVoiceSettings, useVoiceStatus, voiceSupported } from "../lib/speech"
import { chordLabel, voiceChord } from "../lib/shortcuts"
import { isMac } from "../lib/useDictation"
import { Button, cx } from "./ui"

/** Alt+Shift+V (by key position, so it works on any layout and on macOS where Option changes the letter). */
const isVoiceShortcut = (e: KeyboardEvent) => e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey && e.code === "KeyV"

/** Phones and tablets say "Tap"; a mouse says "Click". */
const touch = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches

/**
 * The header's speaker unlocks audio on its first tap, then stops speech and toggles voice.
 * It keeps the same place and size through unlock. Subscribes on its own, so speaking never
 * re-renders the chat.
 */
export function VoiceControl() {
  const s = useVoiceSettings()
  const status = useVoiceStatus()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isVoiceShortcut(e) || e.repeat) return
      e.preventDefault()
      toggleVoice()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  if (!voiceSupported()) return null
  const locked = s.enabled && status.locked
  const label = locked ? `${touch() ? "Tap" : "Click"} to enable voice` : s.enabled ? (status.speaking ? "Stop speaking and turn voice off" : "Turn voice off") : "Turn voice on"
  return (
    <Button size="sm" variant="ghost" className="h-11 w-11 shrink-0 !p-0" data-voice-unlock={locked ? "" : undefined} title={`${label} (${chordLabel(voiceChord, isMac())})`} aria-label={label} aria-keyshortcuts="Alt+Shift+V" aria-pressed={s.enabled} onClick={locked ? () => unlockVoice(true) : toggleVoice}>
      {s.enabled ? (
        <Volume2 className={cx("h-3.5 w-3.5", status.speaking ? "animate-pulse text-yard-400 motion-reduce:animate-none" : "text-zinc-300")} />
      ) : (
        <VolumeX className="h-3.5 w-3.5" />
      )}
    </Button>
  )
}
