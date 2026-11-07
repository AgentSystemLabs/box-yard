import { afterEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { IdentityDetector } from "../server/identity/detect.js"
import { computer } from "./identityFixtures.js"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { Identities } from "../server/identity/identities.js"
import { SecretBox } from "../server/identity/secretBox.js"
import { tmpDir } from "./helpers.js"
import { GPG_FP, fakeGpg } from "./gpgFixtures.js"

afterEach(() => vi.unstubAllEnvs())

function setup() {
  const g = fakeGpg()
  vi.stubEnv("PATH", g.env.PATH!)
  vi.stubEnv("GNUPGHOME", g.env.GNUPGHOME!)
  const dataDir = tmpDir("gpg-identity-")
  const db = openDb(dataDir)
  const store = new Store(db)
  let registration: "present" | "absent" | "denied" = "present"
  const github = (async (url: string) => {
    const route = new URL(url).pathname
    if (route === "/user") return Response.json({ login: "bot", id: 1 }, { headers: { "x-oauth-scopes": "repo" } })
    if (route === "/user/emails") return Response.json([{ email: "bot@example.com", verified: true }])
    if (route === "/user/gpg_keys") return registration === "denied" ? new Response("{}", { status: 403 }) : Response.json(registration === "present" ? [{ key_id: GPG_FP.slice(-16) }] : [])
    return new Response("{}", { status: 404 })
  }) as typeof fetch
  const ids = new Identities({ db, secrets: new SecretBox({ dataDir }), credentials: { get: () => "", claudeEnv: () => ({}) }, github })
  const i = ids.create({ name: "GPG", author: { name: "Bot", email: "bot@example.com" } })
  return { g, db, ids, store, i, registration: (v: typeof registration) => { registration = v } }
}

describe("GPG identity validation", () => {
  it("distinguishes a key absent from GitHub from a token that cannot list keys, and checks UID email and local existence", async () => {
    const r = setup()
    try {
      await r.ids.saveSigning(r.i.id, { kind: "gpg", keyId: GPG_FP })
      await r.ids.saveToken(r.i.id, { token: "fake-token-for-testing" })
      expect((await r.ids.test(r.i.id, [])).ok).toBe(true)
      r.registration("denied")
      const unknown = await r.ids.test(r.i.id, [])
      expect(unknown.ok).toBe(true)
      expect(unknown.lines.join("\n")).toContain("read:gpg_key")
      r.registration("absent")
      expect((await r.ids.test(r.i.id, [])).ok).toBe(false)
      r.registration("present")
      r.ids.update(r.i.id, { author: { name: "Bot", email: "wrong@example.com" } })
      expect((await r.ids.test(r.i.id, [])).lines.join("\n")).toContain("doesn't match any email")
      fs.writeFileSync(r.g.mode, "missing")
      expect((await r.ids.test(r.i.id, [])).lines.join("\n")).toContain("couldn't list this secret key")
    } finally { r.db.close() }
  })

  it.each(["openpgp", "unset"])("detects a configured GPG key with format %s from the host keyring", async (format) => {
    const g = fakeGpg()
    const pc = computer()
    fs.appendFileSync(path.join(pc.home, ".gitconfig-acme"), `\n[user]\nsigningKey = ${GPG_FP}\n[gpg]\nformat = openpgp\n`)
    // The global scope covers unset format; the includeIf scope covers an explicit OpenPGP override of SSH.
    fs.appendFileSync(path.join(pc.home, ".gitconfig"), `\n[user]\nsigningKey = ${GPG_FP}\n${format === "openpgp" ? "[gpg]\nformat = openpgp\n" : ""}`)
    const detector = new IdentityDetector({ home: pc.home, env: { ...pc.env, PATH: `${g.dir}:${pc.env.PATH}`, GNUPGHOME: g.env.GNUPGHOME } })
    const d = await detector.detect({ projects: [], identities: [], online: false })
    for (const author of d.authors) expect(author.signing).toMatchObject({ kind: "gpg", format: "openpgp", ref: `gpg:${GPG_FP}`, problem: null })
  })

  it("rejects pasting secrets, non-local identity runners, and existing non-local projects without altering the saved key", async () => {
    const r = setup()
    try {
      for (const input of [{ kind: "gpg", keyId: "-----BEGIN PGP PRIVATE KEY BLOCK-----" }, { kind: "gpg", keyId: GPG_FP, privateKey: "secret" }, { kind: "gpg", keyId: GPG_FP, passphrase: "secret" }]) {
        await expect(r.ids.saveSigning(r.i.id, input)).rejects.toThrow()
      }
      r.ids.update(r.i.id, { runners: ["docker"] })
      await expect(r.ids.saveSigning(r.i.id, { kind: "gpg", keyId: GPG_FP })).rejects.toThrow(/local runner/)
      r.ids.update(r.i.id, { runners: null })
      const p = r.store.createProject({ name: "remote", identityId: r.i.id })
      await expect(r.ids.saveSigning(r.i.id, { kind: "gpg", keyId: GPG_FP })).rejects.toThrow(/must use the local runner/)
      r.db.prepare("UPDATE projects SET runner = 'local' WHERE id = ?").run(p.id)
      await r.ids.saveSigning(r.i.id, { kind: "gpg", keyId: GPG_FP })
      expect(() => r.ids.update(r.i.id, { runners: ["docker"] })).toThrow()
      expect(r.ids.signingFor(p.id)).toMatchObject({ format: "openpgp", privateKey: null, fingerprint: GPG_FP })
    } finally { r.db.close() }
  })
})
