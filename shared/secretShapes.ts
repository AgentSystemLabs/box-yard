/** Shapes keys and tokens take, redacted even when we don't know the value (an error that echoes a typed key). */
export const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-(proj|svcacct|admin)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[opsu]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\brpa_[A-Za-z0-9]{16,}/g,
  // A Cursor API key (cursor.com/dashboard › API Keys).
  /\bkey_[0-9a-f]{32,}\b/g,
  /\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
]

/** `text` with anything shaped like a key or token replaced by "[redacted]" ("Bearer [redacted]" keeps its word). */
export function redactSecretShapes(text: string): string {
  let out = text
  for (const p of SECRET_PATTERNS) out = out.replace(p, (_m, word?: string) => (typeof word === "string" && /^(bearer|token)$/i.test(word) ? `${word} [redacted]` : "[redacted]"))
  return out
}
