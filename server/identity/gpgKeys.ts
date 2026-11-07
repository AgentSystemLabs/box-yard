import { execFile } from "node:child_process"
import { GPG_KEY_ID_RE } from "../../shared/identities.js"

// Only identifiers and public metadata leave this module. Never export a secret key or forward gpg's diagnostics.
export class GpgKeyError extends Error {}
export const normalizeGpgId = (id: string) => id.replace(/^0x/i, "").toUpperCase()
export interface GpgKeyInfo {
  fingerprint: string
  emails: string[]
  /** Includes subkeys, for GitHub registration and signature checks. */
  fingerprints: string[]
}

/** gpg --with-colons is machine-readable public metadata, even for --list-secret-keys. */
export function parseGpgSecretKeys(text: string): GpgKeyInfo[] {
  const keys: GpgKeyInfo[] = []
  let key: GpgKeyInfo | null = null
  let primary = false
  for (const line of text.split(/\r?\n/)) {
    const f = line.split(":")
    if (f[0] === "sec") {
      const expired = Number(f[6]) > 0 && Number(f[6]) * 1000 <= Date.now()
      key = !["r", "e", "d", "i"].includes(f[1] ?? "") && !expired ? { fingerprint: "", emails: [], fingerprints: [] } : null
      if (key) keys.push(key)
      primary = true
    } else if (f[0] === "ssb") primary = false
    else if (key && f[0] === "fpr" && /^[A-Fa-f0-9]{40,64}$/.test(f[9] ?? "")) {
      const fp = normalizeGpgId(f[9]!)
      if (primary && !key.fingerprint) key.fingerprint = fp
      key.fingerprints.push(fp)
    } else if (key && f[0] === "uid" && !["r", "e", "d", "i"].includes(f[1] ?? "")) {
      const uid = (f[9] ?? "").replace(/\\x([a-fA-F0-9]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      const email = /<([^<>\s]+@[^<>\s]+)>/.exec(uid)?.[1] ?? (/^[^\s<>]+@[^\s<>]+$/.test(uid) ? uid : null)
      if (email) key.emails.push(email.toLowerCase())
    }
  }
  return keys.filter((k) => k.fingerprint)
}

export async function gpgKeyInfo(keyId: string, o: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<GpgKeyInfo> {
  if (!GPG_KEY_ID_RE.test(keyId)) throw new GpgKeyError("A GPG key is referenced by its hex key id or fingerprint, never a private key, email or passphrase.")
  const out = await new Promise<string>((resolve, reject) => {
    const child = execFile("gpg", ["--batch", "--no-tty", "--with-colons", "--fixed-list-mode", "--with-fingerprint", "--with-subkey-fingerprint", "--list-secret-keys", "--", normalizeGpgId(keyId)],
      { env: o.env ?? process.env, timeout: o.timeoutMs ?? 15_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (!err) resolve(stdout)
        else reject(new GpgKeyError((err as NodeJS.ErrnoException).code === "ENOENT" ? "This computer has no gpg. Install GnuPG to use a GPG identity." : "GPG couldn't list this secret key (missing, unavailable or timed out). Check gpg --list-secret-keys on this computer."))
      })
    child.stdin?.on("error", () => {})
    child.stdin?.end()
  })
  const want = normalizeGpgId(keyId)
  const keys = parseGpgSecretKeys(out).filter((k) => k.fingerprints.some((fp) => fp.endsWith(want)))
  if (keys.length !== 1) throw new GpgKeyError("GPG found no unique, unexpired secret key for that id. Use the full fingerprint from gpg --list-secret-keys.")
  // Pin the primary fingerprint: gpg can choose its signing subkey, and the push guard checks %GP as well as %GF.
  return keys[0]!
}
