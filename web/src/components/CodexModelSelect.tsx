import { CODEX_MODELS, isClaudeModel } from "../../../shared/agentCli"
import { Select } from "./ui"

/** A dated CLI catalog, retaining any saved name so opening Settings never replaces a choice. */
export function CodexModelSelect({ id, value, onChange, testId }: { id: string; value: string; onChange: (v: string) => void; testId: string }) {
  const unlisted = value !== "" && !CODEX_MODELS.some((m) => m.id === value)
  return <div className="min-w-0 space-y-1.5">
    <Select id={id} className="w-full" value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId} aria-describedby={unlisted ? `${id}-warning` : undefined}>
      <option value="">Codex CLI default (saved choice)</option>
      {unlisted && <option value={value}>{value} (saved, unverified)</option>}
      {CODEX_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label} · {m.id}</option>)}
    </Select>
    {unlisted && <p id={`${id}-warning`} role="status" className="text-xs leading-relaxed text-amber-300">
      {isClaudeModel(value) ? "This saved Claude model cannot run on Codex. Select a Codex model to replace it." : "This saved model is outside the verified Codex catalog. It is kept until you choose a replacement; check availability with your Codex account."}
    </p>}
  </div>
}
