import { describe, expect, it } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { SettingsStore, captainIcon } from "../server/settings.js"
import { CAPTAIN_ICON_GROUPS, captainIconInfo, captainIcons, isCaptainIcon, searchCaptainIcons } from "../shared/captainIcons.js"
import { DEFAULT_CAPTAIN_ICON, captainMark } from "../shared/captainMark.js"
import { CAPTAIN_ICON_COMPONENTS } from "../web/src/lib/captainIconCatalog.js"
import { tmpDir } from "./helpers.js"

// A Captain's icon (docs/captain-icons.md): an id from the catalogue, set for every Captain in Settings and per project,
// with the project's pick, then its image, then Settings' icon, then the Captain's cap.

const noEnv = { orchestratorModel: "", workerModel: "", captainModel: "", captainEffort: "" as const }
const memStore = () => new Store(openDb(tmpDir(), ":memory:"))
const ids = () => captainIcons().map((i) => i.id)

describe("the Captain icon catalogue", () => {
  it("is a few hundred icons, each once, starting with the cap, the helm and the bot", () => {
    expect(captainIcons().length).toBeGreaterThanOrEqual(400)
    expect(new Set(ids()).size).toBe(ids().length)
    expect(ids().slice(0, 3)).toEqual(["captain-cap", "helm", "bot"])
    expect(DEFAULT_CAPTAIN_ICON).toBe("captain-cap")
    expect(captainIconInfo("captain-cap")).toMatchObject({ label: "Captain's cap", group: "Box Yard" })
    // Labels default to the id in words.
    expect(captainIconInfo("ship-wheel")!.label).toBe("Ship wheel")
    for (const g of CAPTAIN_ICON_GROUPS) expect(g.icons.length, g.name).toBeGreaterThan(0)
  })

  it("draws every id with its own component: lucide's canonical icon of that name, or the yard's", () => {
    expect(Object.keys(CAPTAIN_ICON_COMPONENTS).sort()).toEqual([...ids()].sort())
    for (const id of ids()) {
      const svg = renderToStaticMarkup(createElement(CAPTAIN_ICON_COMPONENTS[id]))
      expect(svg.match(/class="([^"]*)"/)?.[1]?.split(" "), id).toContain(`lucide-${id}`)
    }
  })

  it("takes only its own ids: never markup, a name in other case, or nothing", () => {
    expect(isCaptainIcon("anchor")).toBe(true)
    for (const v of ["", "Anchor", "<svg onload=alert(1)/>", "lucide-anchor", "constructor", "__proto__", null, undefined, 3]) expect(isCaptainIcon(v), String(v)).toBe(false)
    expect(captainIconInfo("toString")).toBeUndefined()
  })

  it("searches by the start of each word, every word of the query", () => {
    expect(searchCaptainIcons("")).toHaveLength(captainIcons().length)
    expect(searchCaptainIcons("  ")).toHaveLength(captainIcons().length)
    expect(searchCaptainIcons("sh wh").map((i) => i.id)).toContain("ship-wheel")
    expect(searchCaptainIcons("ANCH").map((i) => i.id)).toContain("anchor")
    // Its extra words too: the cap is a hat, the helm steers.
    expect(searchCaptainIcons("hat").map((i) => i.id)).toContain("captain-cap")
    expect(searchCaptainIcons("steer").map((i) => i.id)).toContain("helm")
    // The group's name.
    expect(searchCaptainIcons("sea").map((i) => i.id)).toEqual(expect.arrayContaining(["anchor", "ship", "lighthouse"]))
    // Not the middle of a word, and every word must match.
    expect(searchCaptainIcons("nchor").map((i) => i.id)).not.toContain("anchor")
    expect(searchCaptainIcons("anchor zzz")).toEqual([])
  })
})

describe("captainMark: which icon a Captain shows", () => {
  it("is the project's pick, then its image, then Settings' icon, then the cap", () => {
    const image = "/api/projects/prj_a/icon?v=1"
    expect(captainMark({ captainIcon: "crown", iconUrl: image }, "anchor")).toEqual({ kind: "icon", id: "crown", from: "project" })
    expect(captainMark({ captainIcon: null, iconUrl: image }, "anchor")).toEqual({ kind: "image", url: image })
    expect(captainMark({ captainIcon: null, iconUrl: null }, "anchor")).toEqual({ kind: "icon", id: "anchor", from: "settings" })
    expect(captainMark({ captainIcon: null, iconUrl: null }, null)).toEqual({ kind: "icon", id: "captain-cap", from: "settings" })
    // No project (a Captain chip before the projects load): Settings' icon.
    expect(captainMark(null, "anchor")).toEqual({ kind: "icon", id: "anchor", from: "settings" })
    expect(captainMark(undefined, undefined)).toEqual({ kind: "icon", id: "captain-cap", from: "settings" })
  })
})

describe("Settings › Coordinator › Captain icon", () => {
  it("is the cap by default, saves an id from the catalogue, and goes back to the cap on reset", () => {
    const settings = new SettingsStore(memStore(), noEnv)
    expect(settings.info().settings.captainIcon).toBe("captain-cap")
    expect(settings.info().sources.captainIcon).toBe("default")
    const info = settings.update({ captainIcon: "anchor" })
    expect(info.settings.captainIcon).toBe("anchor")
    expect(info.sources.captainIcon).toBe("ui")
    expect(settings.reset(["captainIcon"]).settings.captainIcon).toBe("captain-cap")
  })

  it("refuses anything but a catalogue id, and keeps what was saved", () => {
    const settings = new SettingsStore(memStore(), noEnv)
    settings.update({ captainIcon: "crown" })
    for (const v of ["not-an-icon", '<svg xmlns="http://www.w3.org/2000/svg"/>', ""]) expect(() => settings.update({ captainIcon: v }), v).toThrow(/isn't one of the Captain icons/)
    for (const v of [null, 7, { id: "anchor" }]) expect(() => settings.update({ captainIcon: v }), String(v)).toThrow()
    expect(settings.get().captainIcon).toBe("crown")
    // The project PATCH and update_project use the same check.
    expect(captainIcon.nullable().safeParse(null).success).toBe(true)
    expect(captainIcon.safeParse("helm").success).toBe(true)
    expect(captainIcon.safeParse("Helm").success).toBe(false)
  })

  it("reads an id this build doesn't know (an icon since taken out) as the cap, and keeps the other settings", () => {
    const store = memStore()
    store.setKv("settings", JSON.stringify({ captainIcon: "retired-icon", captainEffort: "low" }))
    const settings = new SettingsStore(store, noEnv).get()
    expect(settings.captainIcon).toBe("captain-cap")
    expect(settings.captainEffort).toBe("low")
  })
})

describe("a project's Captain icon", () => {
  it("is null (Use default) for a new project, saves a pick, and goes back to null", () => {
    const store = memStore()
    const p = store.createProject({ name: "demo" })
    expect(p.captainIcon).toBeNull()
    expect(store.updateProject(p.id, { captainIcon: "lighthouse" }).captainIcon).toBe("lighthouse")
    expect(store.getProject(p.id)!.captainIcon).toBe("lighthouse")
    // Another change leaves it be.
    expect(store.updateProject(p.id, { name: "demo two" }).captainIcon).toBe("lighthouse")
    expect(store.updateProject(p.id, { captainIcon: null }).captainIcon).toBeNull()
  })

  it("reads a stored id this build doesn't know as Use default", () => {
    const store = memStore()
    const p = store.createProject({ name: "demo" })
    store.db.prepare("UPDATE projects SET captain_icon = ? WHERE id = ?").run("<svg/>", p.id)
    expect(store.getProject(p.id)!.captainIcon).toBeNull()
  })

  it("has its own column, added by a migration", () => {
    const db = openDb(tmpDir(), ":memory:")
    const cols = (db.prepare("PRAGMA table_info(projects)").all() as { name: string }[]).map((c) => c.name)
    expect(cols).toContain("captain_icon")
  })
})
