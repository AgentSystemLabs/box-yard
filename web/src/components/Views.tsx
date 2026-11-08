import { useState } from "react"
import { Lock } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import { useHealth, keys } from "../lib/queries"
import { api } from "../lib/api"
import { Button, inputClass } from "./ui"
import { useOpenSettings } from "./SettingsHost"

export function HealthBanner() {
  const health = useHealth()
  const openSettings = useOpenSettings()
  const [hidden, setHidden] = useState(false)
  if (hidden || !health.data || health.data.problems.length === 0) return null
  const setupSection = health.data.problems.some((p) => p.includes("Settings › Box providers")) ? "runners" : health.data.problems.some((p) => p.includes("Settings › Credentials")) ? "credentials" : null
  return (
    <div className="flex items-start gap-3 border-b border-amber-900/40 bg-amber-950/30 px-4 py-2 text-xs text-amber-200">
      <div className="flex-1 space-y-0.5">
        {health.data.problems.map((p) => (
          <div key={p}>⚠ {p}</div>
        ))}
      </div>
      {setupSection && (
        <button className="-my-3 grid min-h-11 place-items-center rounded-lg px-2 font-medium text-amber-200 hover:text-amber-100 sm:-my-1 sm:min-h-0" onClick={() => openSettings(setupSection)}>
          set up
        </button>
      )}
      <button className="-my-3 grid min-h-11 place-items-center rounded-lg px-2 text-amber-400 hover:text-amber-200 sm:-my-1 sm:min-h-0" onClick={() => setHidden(true)}>
        dismiss
      </button>
    </div>
  )
}

export function Login() {
  const qc = useQueryClient()
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  return (
    <div className="grid min-h-[100dvh] place-items-center p-4">
      <form
        className="w-full max-w-sm space-y-4 rounded-2xl border border-zinc-800 bg-zinc-950 p-6"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError("")
          try {
            await api("/api/login", { body: { password } })
            await qc.invalidateQueries({ queryKey: keys.me })
          } catch (err) {
            setError((err as Error).message)
          } finally {
            setBusy(false)
          }
        }}
      >
        <div className="flex items-center gap-2 text-zinc-100">
          <Lock className="h-4 w-4 text-yard-400" /> <span className="font-semibold">Box Yard</span>
        </div>
        <input type="password" autoFocus className={inputClass} placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <div className="text-sm text-red-400">{error}</div>}
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          Log in
        </Button>
      </form>
    </div>
  )
}
