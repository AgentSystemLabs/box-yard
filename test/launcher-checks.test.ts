// The npx launcher's up-front checks (launcher/checks.mjs) and the small pure pieces around them: its command line,
// settings file, environment clean-up and systemd unit. Each check reads a made-up computer, so every OS and every
// missing piece is covered without touching this one.
import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { checkComputer, formatBytes, formatProblems, INSTALL_FREE_BYTES, installHint, nodeTooOld, osFamily, pickPort, which } from "../launcher/checks.mjs"
import { cleanEnv, installEnv } from "../launcher/install.mjs"
import { dataDirFor, parseArgs } from "../launcher/main.mjs"
import { boxyardHome, ensureEnvFile, githubPage, layout, parseEnv, readEnvFile, repoUrl, setting, settingPath } from "../launcher/paths.mjs"
import { unitText } from "../launcher/service.mjs"
import { tmpDir } from "./helpers.js"

const GB = 1024 ** 3

/** A computer with everything Box Yard wants; each test takes one piece away. */
function computer(over: Record<string, unknown> = {}) {
  const tools = new Set(["git", "npm", "claude", "gh"])
  return {
    platform: "linux",
    nodeVersion: "22.12.0",
    uid: 1000,
    osRelease: () => 'NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\n',
    which: (cmd: string) => (tools.has(cmd) ? `/usr/bin/${cmd}` : null),
    writable: () => null,
    freeBytes: () => 50 * GB,
    tools,
    ...over,
  }
}

const want = { install: true, dirs: ["/home/dev/.boxyard", "/home/dev/.boxyard/data"], agents: true, allowRoot: false }
const ids = (list: { id: string }[]) => list.map((p) => p.id)

describe("nodeTooOld", () => {
  it("compares major, minor and patch, with or without the v", () => {
    expect(nodeTooOld("22.12.0")).toBe(false)
    expect(nodeTooOld("v22.12.1")).toBe(false)
    expect(nodeTooOld("24.0.0")).toBe(false)
    expect(nodeTooOld("22.11.9")).toBe(true)
    expect(nodeTooOld("v20.19.0")).toBe(true)
    expect(nodeTooOld("18.20.4")).toBe(true)
    expect(nodeTooOld("22.12.0", "22.12.1")).toBe(true)
  })
})

describe("osFamily and installHint", () => {
  it("reads the family from /etc/os-release, ID_LIKE included", () => {
    expect(osFamily("darwin")).toBe("mac")
    expect(osFamily("win32")).toBe("windows")
    expect(osFamily("linux", "ID=ubuntu\nID_LIKE=debian\n")).toBe("debian")
    expect(osFamily("linux", "ID=pop\nID_LIKE=\"ubuntu debian\"\n")).toBe("debian")
    expect(osFamily("linux", 'ID="rocky"\nID_LIKE="rhel centos fedora"\n')).toBe("fedora")
    expect(osFamily("linux", "ID=arch\n")).toBe("arch")
    expect(osFamily("linux", "ID=alpine\n")).toBe("alpine")
    expect(osFamily("linux", "")).toBe("linux")
    // A VERSION_ID line mentioning a family isn't an ID.
    expect(osFamily("linux", "ID=nixos\nVERSION_ID=debian-ish\n")).toBe("linux")
  })

  it("names the package manager command for each family", () => {
    expect(installHint("git", "debian")).toBe("sudo apt-get install -y git")
    expect(installHint("git", "fedora")).toBe("sudo dnf install -y git")
    expect(installHint("git", "arch")).toBe("sudo pacman -S --needed git")
    expect(installHint("git", "alpine")).toBe("sudo apk add git")
    expect(installHint("git", "mac")).toMatch(/xcode-select --install/)
    expect(installHint("git", "linux")).toMatch(/git-scm\.com/)
    expect(installHint("build-tools", "debian")).toBe("sudo apt-get install -y python3 make g++")
    expect(installHint("node", "mac")).toMatch(/nvm install 22/)
    expect(installHint("claude", "debian")).toMatch(/npm install -g @anthropic-ai\/claude-code/)
    expect(installHint("gh", "mac")).toMatch(/brew install gh/)
  })
})

describe("checkComputer", () => {
  it("passes a computer with everything", async () => {
    expect(await checkComputer(want, computer())).toEqual({ stop: [], warn: [] })
  })

  it("stops on Windows at once, pointing to WSL 2", async () => {
    const r = await checkComputer(want, computer({ platform: "win32", nodeVersion: "18.0.0" }))
    expect(ids(r.stop)).toEqual(["windows"])
    expect(r.stop[0]!.fix).toMatch(/wsl --install/)
  })

  it("stops on an old Node with this OS's install command", async () => {
    const r = await checkComputer(want, computer({ nodeVersion: "20.11.1" }))
    expect(ids(r.stop)).toEqual(["node"])
    expect(r.stop[0]!.message).toMatch(/22\.12\.0 or newer; this is 20\.11\.1/)
    expect(r.stop[0]!.fix).toMatch(/nodejs\.org/)
  })

  it("stops as root unless --allow-root, since Claude Code refuses full permissions as root", async () => {
    const root = await checkComputer(want, computer({ uid: 0 }))
    expect(ids(root.stop)).toEqual(["root"])
    expect(root.stop[0]!.fix).toMatch(/adduser boxyard/)
    expect(root.stop[0]!.fix).toMatch(/--allow-root/)
    expect((await checkComputer({ ...want, allowRoot: true }, computer({ uid: 0 }))).stop).toEqual([])
  })

  it("stops without git, with the package manager's command", async () => {
    const c = computer()
    c.tools.delete("git")
    const r = await checkComputer(want, c)
    expect(ids(r.stop)).toEqual(["git"])
    expect(r.stop[0]!.fix).toBe("Install it: sudo apt-get install -y git")
    // git is needed for tasks and updates even once installed.
    expect(ids((await checkComputer({ ...want, install: false }, c)).stop)).toEqual(["git"])
  })

  it("needs npm only to install", async () => {
    const c = computer()
    c.tools.delete("npm")
    expect(ids((await checkComputer(want, c)).stop)).toEqual(["npm"])
    expect((await checkComputer({ ...want, install: false }, c)).stop).toEqual([])
  })

  it("stops on a folder it can't write, saying how to give it back", async () => {
    const r = await checkComputer(want, computer({ writable: (dir: string) => (dir.endsWith("data") ? "EACCES" : null) }))
    expect(ids(r.stop)).toEqual(["writable"])
    expect(r.stop[0]!.message).toBe("Box Yard can't write to /home/dev/.boxyard/data (EACCES).")
    expect(r.stop[0]!.fix).toMatch(/sudo chown -R "\$USER" \/home\/dev\/\.boxyard\/data/)
  })

  it("quotes a folder with spaces in the chown command", async () => {
    const r = await checkComputer({ ...want, dirs: ["/home/dev/my yard"] }, computer({ writable: () => "EACCES" }))
    expect(r.stop[0]!.fix).toContain("'/home/dev/my yard'")
  })

  it("stops an install short of disk, and only warns a running one", async () => {
    const tight = computer({ freeBytes: () => INSTALL_FREE_BYTES / 2 })
    const install = await checkComputer(want, tight)
    expect(ids(install.stop)).toEqual(["disk"])
    expect(install.stop[0]!.message).toMatch(/Only 512 MB is free/)
    const running = await checkComputer({ ...want, install: false }, tight)
    expect(running.stop).toEqual([])
    expect(ids(running.warn)).toEqual(["disk"])
    // Unknown free space isn't a problem.
    expect(await checkComputer(want, computer({ freeBytes: () => null }))).toEqual({ stop: [], warn: [] })
  })

  it("only warns about claude and gh, and not for the demo", async () => {
    const c = computer()
    c.tools.delete("claude")
    c.tools.delete("gh")
    const r = await checkComputer(want, c)
    expect(r.stop).toEqual([])
    expect(ids(r.warn)).toEqual(["claude", "gh"])
    expect(r.warn[0]!.fix).toMatch(/npm install -g @anthropic-ai\/claude-code/)
    expect((await checkComputer({ ...want, agents: false }, c)).warn).toEqual([])
  })

  it("lists every stop problem at once", async () => {
    const c = computer({ nodeVersion: "20.0.0", uid: 0, writable: () => "EROFS", freeBytes: () => 0 })
    c.tools.delete("git")
    c.tools.delete("npm")
    expect(ids((await checkComputer(want, c)).stop)).toEqual(["node", "root", "git", "npm", "writable", "disk"])
  })
})

describe("formatting", () => {
  it("prints a problem and its fix", () => {
    expect(formatProblems([{ id: "git", message: "git isn't installed.", fix: "brew install git" }], "✗")).toEqual(["✗ git isn't installed.", "  → brew install git"])
    expect(formatBytes(1.5 * GB)).toBe("1.5 GB")
    expect(formatBytes(300 * 1024 ** 2)).toBe("300 MB")
  })
})

describe("pickPort", () => {
  const busy = (taken: number[]) => async (port: number) => !taken.includes(port)

  it("keeps a free port", async () => {
    expect(await pickPort({ port: 3000, explicit: false, host: "127.0.0.1" }, busy([]))).toEqual({ port: 3000, moved: false })
  })

  it("moves the default to the next free port", async () => {
    expect(await pickPort({ port: 3000, explicit: false, host: "127.0.0.1" }, busy([3000, 3001]))).toEqual({ port: 3002, moved: true })
  })

  it("stops on a busy port that was asked for, naming who holds it", async () => {
    const r = await pickPort({ port: 4000, explicit: true, host: "127.0.0.1" }, busy([4000]), () => "node (pid 4242)")
    expect(r).toEqual({ error: "Port 4000 is already in use by node (pid 4242).", fix: "Stop that, or pick another port: --port 4001 (or PORT in the settings file)." })
  })

  it("gives up after twenty", async () => {
    const all = Array.from({ length: 21 }, (_, i) => 3000 + i)
    expect((await pickPort({ port: 3000, explicit: false, host: "127.0.0.1" }, busy(all))).error).toBe("Ports 3000–3020 are all in use.")
  })
})

describe("which", () => {
  it("finds an executable file on the PATH, not a folder or a plain file", () => {
    const dir = tmpDir()
    fs.mkdirSync(path.join(dir, "folder"))
    fs.writeFileSync(path.join(dir, "plain"), "")
    fs.writeFileSync(path.join(dir, "tool"), "#!/bin/sh\n", { mode: 0o755 })
    expect(which("tool", `/nowhere${path.delimiter}${dir}`)).toBe(path.join(dir, "tool"))
    expect(which("plain", dir)).toBeNull()
    expect(which("folder", dir)).toBeNull()
    expect(which("tool", "")).toBeNull()
  })
})

describe("parseArgs", () => {
  it("starts by default", () => {
    expect(parseArgs([])).toMatchObject({ command: "start", errors: [], flags: { open: true, public: false } })
  })

  it("reads commands and options, with = or a space", () => {
    expect(parseArgs(["demo", "--port", "4000", "--no-open"])).toMatchObject({ command: "demo", flags: { port: 4000, open: false } })
    expect(parseArgs(["--public", "--host=10.0.0.5", "--data", "~/yard", "-y", "--allow-root"])).toMatchObject({
      command: "start",
      flags: { public: true, host: "10.0.0.5", data: "~/yard", yes: true, allowRoot: true },
    })
    expect(parseArgs(["service", "install", "--port=8080"])).toMatchObject({ command: "service", sub: "install", flags: { port: 8080 } })
    expect(parseArgs(["help"])).toMatchObject({ command: "start", flags: { help: true } })
  })

  it("says what's wrong with a bad command line", () => {
    expect(parseArgs(["--port", "http"]).errors).toEqual(['--port wants a port number, not "http".'])
    expect(parseArgs(["--port", "70000"]).errors).toHaveLength(1)
    expect(parseArgs(["--port"]).errors).toEqual(["--port needs a value."])
    expect(parseArgs(["--host", "--public"]).errors).toEqual(["--host needs a value."])
    expect(parseArgs(["--colour"]).errors).toEqual(["Unknown option --colour."])
    expect(parseArgs(["deploy"]).errors).toEqual(['Unknown command "deploy".'])
  })
})

describe("settings", () => {
  it("keeps everything in ~/.boxyard unless BOXYARD_HOME moves it", () => {
    expect(boxyardHome({}, "/home/dev")).toBe("/home/dev/.boxyard")
    expect(boxyardHome({ BOXYARD_HOME: "~/apps/yard" }, "/home/dev")).toBe("/home/dev/apps/yard")
    expect(boxyardHome({ BOXYARD_HOME: "  " }, "/home/dev")).toBe("/home/dev/.boxyard")
    const L = layout("/home/dev/.boxyard")
    expect(L).toMatchObject({ envFile: "/home/dev/.boxyard/.env", data: "/home/dev/.boxyard/data", demoData: "/home/dev/.boxyard/demo", current: "/home/dev/.boxyard/app/current" })
  })

  it("reads the settings file like the server does", () => {
    expect(parseEnv('# comment\nPORT=4000\nexport HOST="0.0.0.0"\nEMPTY=\nQUOTED=\'a b\'\nPORT=5000\nnot a line\n')).toEqual({ PORT: "4000", HOST: "0.0.0.0", EMPTY: "", QUOTED: "a b" })
  })

  it("lets the environment win, and treats an empty value as unset", () => {
    expect(setting("PORT", { PORT: "4000" }, { PORT: "5000" })).toBe("4000")
    expect(setting("PORT", {}, { PORT: " 5000 " })).toBe("5000")
    expect(setting("PORT", {}, { PORT: "" })).toBeUndefined()
    expect(settingPath("data", "/home/dev/.boxyard", "/home/dev")).toBe("/home/dev/.boxyard/data")
    expect(settingPath("~/elsewhere", "/home/dev/.boxyard", "/home/dev")).toBe("/home/dev/elsewhere")
  })

  it("puts the demo in its own folder, even when BOXYARD_DATA_DIR is set", () => {
    const L = layout("/home/dev/.boxyard")
    const base = { flags: {}, env: {}, fileEnv: { BOXYARD_DATA_DIR: "/srv/yard" }, cwd: "/work", L }
    expect(dataDirFor({ ...base, demo: true })).toBe("/home/dev/.boxyard/demo")
    expect(dataDirFor({ ...base, demo: false })).toBe("/srv/yard")
    expect(dataDirFor({ ...base, fileEnv: {}, demo: false })).toBe("/home/dev/.boxyard/data")
    expect(dataDirFor({ ...base, flags: { data: "here" }, demo: true })).toBe("/work/here")
  })

  it("creates the settings file once, readable only by its owner", () => {
    const file = path.join(tmpDir(), "home", ".env")
    expect(ensureEnvFile(file)).toBe(true)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    fs.appendFileSync(file, "PORT=4100\n")
    expect(ensureEnvFile(file)).toBe(false)
    expect(readEnvFile(file).PORT).toBe("4100")
    expect(readEnvFile(path.join(tmpDir(), "missing"))).toEqual({})
  })

  it("updates from AgentSystemLabs/box-yard unless BOXYARD_UPDATE_REPO says otherwise", () => {
    expect(repoUrl({})).toBe("https://github.com/AgentSystemLabs/box-yard.git")
    expect(repoUrl({ BOXYARD_UPDATE_REPO: "/tmp/bare.git" })).toBe("/tmp/bare.git")
    expect(githubPage("https://github.com/AgentSystemLabs/box-yard.git")).toBe("https://github.com/AgentSystemLabs/box-yard")
    expect(githubPage("git@github.com:acme/yard.git")).toBe("https://github.com/acme/yard")
    expect(githubPage("/tmp/bare.git")).toBeNull()
  })
})

describe("the server's environment", () => {
  it("drops what npx adds, so the server and its agents don't run npm's copies", () => {
    const env = cleanEnv({
      PATH: ["/home/dev/.npm/_npx/abc/node_modules/.bin", "/usr/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin", "/usr/local/bin", "/usr/bin"].join(path.delimiter),
      npm_config_cache: "/home/dev/.npm",
      npm_lifecycle_event: "npx",
      INIT_CWD: "/home/dev",
      NODE_CHANNEL_FD: "3",
      HOME: "/home/dev",
      ANTHROPIC_API_KEY: "sk-ant-example",
    })
    expect(env).toEqual({ PATH: ["/usr/local/bin", "/usr/bin"].join(path.delimiter), HOME: "/home/dev", ANTHROPIC_API_KEY: "sk-ant-example" })
  })

  it("installs without NODE_ENV (it would skip the build tools) and never prompts for a password", () => {
    const env = installEnv({ PATH: "/usr/bin", NODE_ENV: "production" })
    expect(env.NODE_ENV).toBeUndefined()
    expect(env.GIT_TERMINAL_PROMPT).toBe("0")
  })
})

describe("the systemd unit", () => {
  it("runs the installed launcher, keeps agents through a restart, and quotes what it must", () => {
    const text = unitText({ node: "/usr/bin/node", launcher: "/home/dev/.boxyard/app/current/bin/box-yard.mjs", args: ["--host", "0.0.0.0"], env: { PATH: "/usr/bin:/bin", BOXYARD_HOME: undefined, EMPTY: "" } })
    expect(text).toContain('ExecStart="/usr/bin/node" "/home/dev/.boxyard/app/current/bin/box-yard.mjs" "start" "--no-open" "--host" "0.0.0.0"')
    expect(text).toContain('Environment="PATH=/usr/bin:/bin"')
    expect(text).not.toContain("BOXYARD_HOME")
    expect(text).not.toContain("EMPTY")
    expect(text).toContain("KillMode=process")
    expect(text).toContain("Restart=on-failure")
    expect(text).toContain("WantedBy=default.target")
    expect(unitText({ node: "/n", launcher: '/a "b"', args: [], env: {} })).toContain('"/a \\"b\\""')
  })
})
