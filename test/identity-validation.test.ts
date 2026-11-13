import { describe, expect, it } from "vitest"
import { openDb } from "../server/db.js"
import { Identities, IdentityValidationError } from "../server/identity/identities.js"
import { SecretBox } from "../server/identity/secretBox.js"
import { GITHUB_OWNER_RE } from "../shared/identities.js"
import { identityOwner, identityPatch, tokenInput } from "../shared/identityValidation.js"
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

  it("accepts underscores after the first character, as Enterprise Managed Users' logins have", () => {
    const token = "ghp_example_disposable_token"
    for (const owner of ["jdoe_acme", "JDoe_Acme", "j_doe_acme", "a__b", "a_", "a-_b", "a_-b", "jane-doe_acme", "a1", "a", `a${"_".repeat(38)}`, `a${"-b".repeat(19)}`]) {
      expect(GITHUB_OWNER_RE.test(owner), owner).toBe(true)
      expect(identityOwner.safeParse(owner).success, owner).toBe(true)
    }
    for (const owner of ["_acme", "-acme", "acme-", "acme--corp", "acme_-", "acme.corp", "acme/app", "acme corp", "", `a${"_".repeat(39)}`, "a".repeat(40)]) {
      expect(GITHUB_OWNER_RE.test(owner), owner).toBe(false)
      expect(identityOwner.safeParse(owner).success, owner).toBe(false)
    }
    expect(tokenInput.parse({ owner: " JDoe_Acme ", token }).owner).toBe("jdoe_acme")
    expect(identityPatch.parse({ owners: ["JDoe_Acme", "acme-corp"] }).owners).toEqual(["JDoe_Acme", "acme-corp"])
    expect(identityPatch.safeParse({ owners: ["_acme"] }).error?.issues[0]).toMatchObject({ path: ["owners", 0], message: expect.stringContaining("A GitHub owner") })
  })
})
