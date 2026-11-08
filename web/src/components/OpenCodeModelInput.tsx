import { inputClass } from "./ui"

/** OpenCode's model catalog belongs to the runner/provider; never offer Claude/Codex's unrelated ids. */
export function OpenCodeModelInput({ id, value, onChange, placeholder = "CLI default", testId }: { id?: string; value: string; onChange: (v: string) => void; placeholder?: string; testId?: string }) {
  return <div className="space-y-1.5">
    <input id={id} className={inputClass} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} data-testid={testId} autoComplete="off" spellCheck={false} />
    <p className="text-xs text-zinc-500">Use provider/model or provider/model#variant from <code>opencode models</code> on the runner. Leave blank for its default. API logins only; OpenCode 1.19.5.</p>
  </div>
}
