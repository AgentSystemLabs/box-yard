import { describe, expect, it } from "vitest"
import { openDb } from "../server/db.js"
import { Identities, IdentityValidationError } from "../server/identity/identities.js"
import { SecretBox } from "../server/identity/secretBox.js"
import { identityPatch, tokenInput } from "../shared/identityValidation.js"
import { tmpDir } from "./helpers.js"

describe("identity write validation", () => {
  it("distinguishes Owners from the singular token owner without rejecting a valid hyphenated owner", async () => {
    const dir = tmpDir("identity-validation-")
    const db = openDb(dir)
    try {
      const ids = new Identities({ db, secrets: new SecretBox({ dataDir: dir }), credentials: { get: () => "", claudeEnv: () => ({}) }, mock: true })
      const i = ids.create({ name: "Example Git", owners: ["acme-example-daily"], author: { name: "Example Agent", email: "agent@example.com" } })
      expect(identityPatch.parse({ owners: [" Acme-Example-Daily "] }).owners).toEqual(["Acme-Example-Daily"])
      const before = ids.get(i.id)
      const token = "ghp_example_disposable_token"
      const failure = await ids.saveToken(i.id, { owner: "acme-example/app", token }).catch((err: unknown) => err)
      expect(failure).toBeInstanceOf(IdentityValidationError)
      expect(failure).toMatchObject({ status: 400, fields: [{ path: "owner", message: expect.stringContaining("A GitHub owner") }] })
      expect(String(failure)).toContain("owner: A GitHub owner")
      expect(JSON.stringify(failure)).not.toContain(token)
      expect(ids.get(i.id)).toEqual(before)
      expect(identityPatch.safeParse({ owners: ["acme-example/app"] }).error?.issues[0]?.path).toEqual(["owners", 0])
    } finally { db.close() }
  })

  it("trims and lowercases a single token owner; blank means every owner", () => {
    const token = "ghp_example_disposable_token"
    expect(tokenInput.parse({ owner: " Acme-Corp ", token: ` ${token} ` })).toEqual({ owner: "acme-corp", token })
    expect(tokenInput.parse({ owner: "", token }).owner).toBe("")
    for (const owner of ["https://github.com/acme", "acme/app", "acme, example", "acme example", "acme--example", "-acme", "a".repeat(40)]) {
      expect(tokenInput.safeParse({ owner, token }).success).toBe(false)
    }
  })
})
