import { describe, expect, it } from "vitest"
import fs from "node:fs"
import { gpgKeyInfo, parseGpgSecretKeys } from "../server/identity/gpgKeys.js"
import { githubUserGpgKeys } from "../server/identity/github.js"
import { GPG_FP, GPG_LIST, GPG_SUB, fakeGpg } from "./gpgFixtures.js"

describe("GPG references", () => {
  it("reads only public metadata, resolves primary/subkey ids, and rejects arbitrary selectors and ambiguous keys", async () => {
    const g = fakeGpg()
    for (const id of [GPG_FP, GPG_FP.slice(-16), `0x${GPG_SUB.slice(-8)}`]) {
      expect(await gpgKeyInfo(id, { env: g.env })).toEqual({ fingerprint: GPG_FP, fingerprints: [GPG_FP, GPG_SUB], emails: ["bot@example.com"] })
    }
    for (const id of ["bot@example.com", "--export-secret-keys", "-----BEGIN PGP PRIVATE KEY BLOCK-----"]) await expect(gpgKeyInfo(id, { env: g.env })).rejects.toThrow(/referenced by/)
    expect(parseGpgSecretKeys(GPG_LIST.replace("sec:u:", "sec:r:"))).toEqual([])
    expect(parseGpgSecretKeys(GPG_LIST.replace(":1600000000:0:", ":1600000000:1600000001:"))).toEqual([])
    fs.writeFileSync(g.mode, "missing")
    await expect(gpgKeyInfo(GPG_FP, { env: g.env })).rejects.toThrow(/couldn't list/)
    fs.writeFileSync(`${g.dir}/gpg`, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(GPG_LIST + GPG_LIST)})`, { mode: 0o755 })
    await expect(gpgKeyInfo(GPG_FP, { env: g.env })).rejects.toThrow(/no unique/)
    await expect(gpgKeyInfo(GPG_FP, { env: { PATH: g.dir + "/missing" } })).rejects.toThrow(/no gpg/)
  })

  it("never forwards GPG diagnostics, and bounds a stuck listing", async () => {
    const g = fakeGpg()
    fs.writeFileSync(`${g.dir}/gpg`, `#!${process.execPath}\nprocess.stderr.write('PRIVATE DIAGNOSTIC'); setInterval(() => {}, 1000)`, { mode: 0o755 })
    await expect(gpgKeyInfo(GPG_FP, { env: g.env, timeoutMs: 100 })).rejects.toThrow(/timed out/)
  })

  it("reads GitHub's authenticated GPG keys including subkeys, paginates and distinguishes permission denial", async () => {
    const calls: string[] = []
    const fetcher = (async (url: string) => {
      calls.push(url)
      return Response.json(url.endsWith("page=1") ? Array.from({ length: 100 }, () => ({ key_id: GPG_FP.slice(-16), subkeys: [{ key_id: GPG_SUB.slice(-16) }] })) : [])
    }) as typeof fetch
    expect(await githubUserGpgKeys("fake", fetcher)).toContain(GPG_SUB.slice(-16))
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain("/user/gpg_keys?")
    expect(await githubUserGpgKeys("fake", (async () => new Response("{}", { status: 403 })) as typeof fetch)).toBeNull()
  })
})
