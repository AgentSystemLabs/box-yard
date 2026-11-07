import fs from "node:fs"
import path from "node:path"
import { tmpDir } from "./helpers.js"

export const GPG_FP = "0123456789ABCDEF0123456789ABCDEF01234567"
export const GPG_SUB = "ABCDEF0123456789ABCDEF0123456789ABCDEF01"
export const GPG_LIST = `sec:u:255:22:${GPG_FP.slice(-16)}:1600000000:0::u:::cSC:::+:::::0:
fpr:::::::::${GPG_FP}:
uid:u::::::::Test Bot <bot@example.com>:
ssb:u:255:22:${GPG_SUB.slice(-16)}:1600000000:0:::::s:::+:::::
fpr:::::::::${GPG_SUB}:
`

/** A fake host gpg: public metadata and signing/verification protocol only, never any key material. */
export function fakeGpg() {
  const dir = tmpDir("gpg-host-")
  const mode = path.join(dir, "mode")
  const log = path.join(dir, "calls")
  fs.writeFileSync(mode, "ok")
  fs.writeFileSync(path.join(dir, "gpg"), `#!${process.execPath}
const fs = require("node:fs")
const args = process.argv.slice(2)
const mode = fs.readFileSync(${JSON.stringify(mode)}, "utf8").trim()
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n")
if (args.includes("--list-secret-keys")) {
  if (mode === "missing") process.exit(2)
  process.stdout.write(${JSON.stringify(GPG_LIST)})
} else if (args.includes("--verify")) {
  const sig = fs.readFileSync(args[args.indexOf("--verify") + 1], "utf8")
  const fp = sig.includes("OTHER") ? "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF" : ${JSON.stringify(GPG_SUB)}
  const primary = sig.includes("OTHER") ? fp : ${JSON.stringify(GPG_FP)}
  process.stdout.write("[GNUPG:] NEWSIG\\n[GNUPG:] GOODSIG " + fp.slice(-16) + " Test Bot <bot@example.com>\\n[GNUPG:] VALIDSIG " + fp + " 2026-01-01 1767225600 0 4 0 22 8 00 " + primary + "\\n[GNUPG:] TRUST_UNDEFINED 0 pgp\\n")
} else {
  if (!args.includes("--batch") || !args.includes("--no-tty") || args[args.indexOf("--pinentry-mode") + 1] !== "error") process.exit(3)
  if (mode === "hang") { setInterval(() => {}, 1000); return }
  if (mode === "locked" || mode === "missing") { process.stderr.write("secret diagnostic must not escape"); process.exit(2) }
  if (!args.includes("--output")) process.stdout.write("-----BEGIN PGP SIGNATURE-----\\n\\n" + (mode === "other" ? "OTHER" : "FAKE") + "\\n-----END PGP SIGNATURE-----\\n")
  process.stderr.write("[GNUPG:] SIG_CREATED D 22 8 00 1767225600 " + ${JSON.stringify(GPG_SUB)} + "\\n")
}
`, { mode: 0o755 })
  return { dir, mode, log, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GNUPGHOME: path.join(dir, "keyring") } }
}
