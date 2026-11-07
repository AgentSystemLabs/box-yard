import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { CredentialStore, redact } from "../server/credentials.js"
import { openDb, type DB } from "../server/db.js"
import { Store } from "../server/store.js"
import { codexTurnLogin } from "../server/turnCredentials.js"
import { tmpDir } from "./helpers.js"

const dbs: DB[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close() })

const login = (at: string, token = "refresh-secret-original") => JSON.stringify({
  tokens: { access_token: "access-secret-original", refresh_token: token, account_id: "account-one" }, last_refresh: at,
})
function setup() {
  const dir = tmpDir("codex-credential-file-")
  const file = path.join(dir, "auth.json")
  const db = openDb(dir)
  dbs.push(db)
  const store = new Store(db)
  fs.writeFileSync(file, login("2026-11-01"), { mode: 0o600 })
  return { file, store }
}

describe("explicit server-side Codex login reference", () => {
  it("forwards only an explicitly configured file and exposes only credential status", () => {
    const { file, store } = setup()
    expect(new CredentialStore(store, {}).codexLogin()).toBeNull()
    const creds = new CredentialStore(store, { codexAuthFile: file })
    expect(creds.codexLogin()).toEqual({ kind: "chatgpt", auth: login("2026-11-01") })
    expect(creds.status().codexAuthJson).toEqual({ state: "set", source: "env" })
    expect(JSON.stringify(creds.status())).not.toContain("secret")
    expect(redact("access-secret-original refresh-secret-original", creds.secrets())).not.toContain("secret-original")
    expect(() => creds.update({ codexAuthJson: null })).toThrow("CODEX_AUTH_FILE is set")
  })

  it("keeps explicit JSON and project API keys ahead of the reference, then the reference ahead of saved logins", () => {
    const { file, store } = setup()
    const saved = new CredentialStore(store, {})
    saved.update({ codexAuthJson: login("2026-10-01") })
    const creds = new CredentialStore(store, { codexAuthFile: file, codexApiKey: "global-api-key" })
    expect(creds.codexAuth()).toBe(login("2026-11-01"))
    expect(new CredentialStore(store, { codexAuthFile: file, codexAuthJson: login("2026-11-02") }).codexAuth()).toBe(login("2026-11-02"))
    expect(codexTurnLogin({ CODEX_API_KEY: "project-api-key" }, creds.codexLogin())).toMatchObject({ kind: "api_key", from: "project", env: { CODEX_API_KEY: "project-api-key" } })
  })

  it("rereads file rotations, keeps newer remote refreshes and never modifies the source", () => {
    const { file, store } = setup()
    const creds = new CredentialStore(store, { codexAuthFile: file })
    expect(creds.adoptCodexAuth(login("2026-11-02", "remote-refresh-secret"))).toBe(true)
    expect(creds.codexAuth()).toBe(login("2026-11-02", "remote-refresh-secret"))
    expect(fs.readFileSync(file, "utf8")).toBe(login("2026-11-01"))
    fs.writeFileSync(file, login("2026-11-03", "rotated-secret"))
    expect(creds.codexAuth()).toBe(login("2026-11-03", "rotated-secret"))
  })

  it("refuses missing, invalid and oversized files without exposing bytes or falling back", () => {
    const { file, store } = setup()
    new CredentialStore(store, {}).update({ codexAuthJson: login("2026-10-01") })
    const creds = new CredentialStore(store, { codexAuthFile: file, codexApiKey: "other-account-api-key" })
    for (const invalid of ["private-invalid-content", "x".repeat(50_001), "{}"]) {
      fs.writeFileSync(file, invalid)
      expect(() => creds.codexLogin()).toThrow(/^CODEX_AUTH_FILE must reference a readable, valid Codex auth.json \(at most 50 KB\).$/)
    }
    fs.unlinkSync(file)
    expect(() => creds.codexLogin()).toThrow("CODEX_AUTH_FILE must reference")
  })
})
