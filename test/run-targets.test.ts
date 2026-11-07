import { describe, expect, it } from "vitest"
import {
  drillsInto,
  buildHarnessTargets,
  buildProjectTargets,
  buildRunTargets,
  filterRunTargets,
  harnessesInWords,
  inlinePicksFrom,
  inlinePicksOf,
  insertRunTarget,
  itemExcerpt,
  listItems,
  mentionAt,
  pickConflict,
  pickedRunTarget,
  projectHarnessTarget,
  projectRunTarget,
  projectToken,
  replacePickToken,
  runTargetPickOf,
  scopePicks,
  tokensIn,
  turnPick,
  turnPicks,
  type PlacedPick,
  type RunTargetSources,
} from "../shared/runTargets.js"
import { pickNotes, projectNote, resolveProjectPick } from "../server/runTargets.js"
import { harnessModelTargets } from "../shared/harnessPicks.js"
import { harnessDefaults } from "../shared/harnessDefaults.js"

const ok = { local: null, box: null, docker: null, gpu: null }
const base: RunTargetSources = { problems: ok, machines: [], localLabel: null }

describe("buildRunTargets", () => {
  it("lists the runners, then machines by name, any SSH machine and labels", () => {
    const list = buildRunTargets({
      ...base,
      machines: [
        { name: "tower", labels: ["gpu", "linux"], state: "ready" },
        { name: "Studio-Mac", labels: ["laptops"], state: "offline" },
      ],
    })
    expect(list.map((t) => t.token)).toEqual(["local", "box", "box:small", "box:medium", "box:large", "docker", "gpu", "studio-mac", "tower", "ssh", "label:gpu", "label:laptops", "label:linux"])
    expect(list.find((t) => t.token === "studio-mac")).toMatchObject({ value: "label:studio-mac", label: "Studio-Mac", detail: "SSH · offline (tasks wait)", disabled: null })
    expect(list.find((t) => t.token === "label:gpu")).toMatchObject({ value: "label:gpu", detail: "tower" })
  })

  it("leaves Docker and GPU out while they can't run, and greys out this computer and boxes with the reason", () => {
    const list = buildRunTargets({ ...base, problems: { local: "Claude Code isn't installed", box: "no key", docker: "Docker isn't running", gpu: "no RunPod key" } })
    expect(list.map((t) => t.token)).toEqual(["local", "box", "box:small", "box:medium", "box:large"])
    expect(list[0]!.disabled).toBe("Claude Code isn't installed")
    expect(list[1]!.disabled).toBe("no key")
  })

  it("follows Local means, keeps this computer as @this-computer, and applies a project's identity", () => {
    const list = buildRunTargets({ ...base, machines: [{ name: "mini", labels: ["home"] }], localLabel: "home", identityProblem: (r) => (r === "box" ? "the work identity runs only on this computer" : null) })
    expect(list[0]).toMatchObject({ token: "local", value: "local", label: "SSH machines labelled home", disabled: null })
    expect(list[1]).toMatchObject({ token: "this-computer", value: "this_computer" })
    expect(list.find((t) => t.token === "box")?.disabled).toMatch(/work identity/)
    expect(buildRunTargets({ ...base, localLabel: "nowhere" })[0]!.disabled).toMatch(/no SSH machine has the label nowhere/)
  })

  it("gives a machine whose name is a runner word its label form", () => {
    const list = buildRunTargets({ ...base, machines: [{ name: "box", labels: [] }] })
    expect(list.filter((t) => t.token === "box")).toHaveLength(1)
    expect(list.find((t) => t.kind === "machine")).toMatchObject({ token: "label:box", value: "label:box" })
  })
})

describe("GPU picks: @gpu, @gpu:<cloud> and @gpu:<cloud>:<gpu>", () => {
  const gpu = (problems: Partial<Record<"runpod" | "vast" | "daytona", string | null>> = {}, def: "runpod" | "vast" | "daytona" = "runpod") =>
    buildRunTargets({
      ...base,
      gpu: {
        default: def,
        problems: { runpod: null, vast: "no Vast.ai key", daytona: null, ...problems },
        types: { runpod: ["NVIDIA RTX A5000", "NVIDIA A40"], vast: [], daytona: ["RTX-4090", "H100"] },
      },
    })

  it("names the default cloud on @gpu, and lists each cloud that can run tasks with its GPUs under it", () => {
    const list = gpu({}, "daytona")
    expect(list.find((t) => t.token === "gpu")).toMatchObject({ value: "gpu", detail: "Default: Daytona", disabled: null })
    expect(list.filter((t) => t.kind === "gpu" && !t.under).map((t) => [t.token, t.label, t.detail])).toEqual([
      ["gpu:runpod", "RunPod GPU", "RTX A5000 or A40"],
      ["gpu:daytona", "Daytona", "Default cloud · RTX 4090 or H100"],
      ["daytona", "Daytona", "CPU sizes and GPU machine types"],
    ])
    const h100 = list.find((t) => t.token === "gpu:daytona:h100")
    expect(h100).toMatchObject({ value: "gpu:daytona:h100", kind: "gpu", label: "Daytona H100", under: "gpu:daytona" })
    expect(h100!.detail).toMatch(/80 GB/)
    expect(list.find((t) => t.token === "gpu:daytona:cpu")).toMatchObject({ label: "Daytona CPU only" })
    // Vast.ai has no key: neither it nor its GPUs are listed.
    expect(list.some((t) => t.token.startsWith("gpu:vast"))).toBe(false)
  })

  it("leaves @gpu out when the default cloud can't run tasks, but keeps the clouds that can", () => {
    const list = gpu({ runpod: "no RunPod key" })
    expect(list.some((t) => t.token === "gpu")).toBe(false)
    expect(list.some((t) => t.token === "gpu:daytona")).toBe(true)
  })

  it("greys out every GPU row when the project's identity rules GPUs out", () => {
    const list = buildRunTargets({
      ...base,
      identityProblem: (r) => (r === "gpu" ? "the work identity runs only on this computer" : null),
      gpu: { default: "runpod", problems: { runpod: null, vast: null, daytona: null }, types: { runpod: [], vast: [], daytona: [] } },
    })
    expect(list.filter((t) => t.token.startsWith("gpu")).every((t) => t.disabled === "the work identity runs only on this computer")).toBe(true)
  })

  it("shows a cloud's GPUs once its token is typed, or a GPU's own name, not on a bare @", () => {
    const list = gpu()
    const tokens = (q: string) => filterRunTargets(list, q).map((t) => t.token)
    expect(tokens("")).toEqual(["local", "box", "docker", "gpu", "gpu:runpod", "gpu:daytona", "daytona"])
    expect(tokens("gpu")).toEqual(["gpu", "gpu:runpod", "gpu:daytona"])
    expect(tokens("gpu:daytona")).toEqual(expect.arrayContaining(["gpu:daytona", "gpu:daytona:rtx-4090", "gpu:daytona:h100", "gpu:daytona:cpu"]))
    expect(tokens("gpu:daytona")[0]).toBe("gpu:daytona")
    expect(tokens("gpu:daytona:h")).toEqual(["gpu:daytona:h100", "gpu:daytona:h200"])
    // A GPU's name finds it on every cloud that has it.
    expect(tokens("4090")).toEqual(["gpu:daytona:rtx-4090", "daytona:gpu-rtx-4090"])
    expect(tokens("a5000")).toEqual(["gpu:runpod:rtx-a5000"])
    expect(tokens("bo")).toEqual(["box"])
  })

  it("opens a cloud's GPUs on the first pick, and picks the cloud once its token is typed", () => {
    const list = gpu()
    const daytona = list.find((t) => t.token === "gpu:daytona")!
    expect(drillsInto(daytona, list, "gpu")).toBe(true)
    expect(drillsInto(daytona, list, "gpu:daytona")).toBe(false)
    expect(drillsInto(list.find((t) => t.token === "gpu")!, list, "")).toBe(false)
    expect(drillsInto(list.find((t) => t.token === "gpu:daytona:h100")!, list, "gpu:daytona")).toBe(false)
    // Drilling leaves the caret right after the token, with no space, so the list stays open on its GPUs.
    expect(insertRunTarget("run it @gp", { start: 7, end: 10 }, "gpu:daytona", "@", true)).toEqual({ value: "run it @gpu:daytona", caret: 19 })
    expect(pickedRunTarget("train @gpu:daytona:h100 please", list)?.value).toBe("gpu:daytona:h100")
  })
})

describe("typing @", () => {
  const targets = buildRunTargets({ ...base, machines: [{ name: "studio-mac", labels: ["laptops"] }] })

  it("finds the @word at the caret only where @ starts a word", () => {
    expect(mentionAt("run it @lo", 10)).toEqual({ start: 7, end: 10, query: "lo" })
    expect(mentionAt("@", 1)).toEqual({ start: 0, end: 1, query: "" })
    expect(mentionAt("run @box now", 7)).toEqual({ start: 4, end: 8, query: "bo" })
    expect(mentionAt("mail cody@box.com", 17)).toBeNull()
    expect(mentionAt("run @box now", 12)).toBeNull()
  })

  it("filters by token or label, prefix matches first", () => {
    expect(filterRunTargets(targets, "").length).toBe(targets.filter((t) => !t.under).length)
    expect(filterRunTargets(targets, "lap").map((t) => t.token)).toEqual(["label:laptops"])
    expect(filterRunTargets(targets, "studio").map((t) => t.token)).toEqual(["studio-mac"])
    expect(filterRunTargets(targets, "l")[0]!.token).toBe("local")
  })

  it("inserts the token with one space after it", () => {
    expect(insertRunTarget("run @lo", { start: 4, end: 7 }, "local")).toEqual({ value: "run @local ", caret: 11 })
    expect(insertRunTarget("run @lo now", { start: 4, end: 7 }, "local")).toEqual({ value: "run @local now", caret: 11 })
  })

  it("takes the draft's last @token that names a pickable target", () => {
    expect(pickedRunTarget("fix it @box", targets)?.value).toBe("box")
    expect(pickedRunTarget("on @local, then @studio-mac.", targets)?.value).toBe("label:studio-mac")
    expect(pickedRunTarget("mail me@box.com", targets)).toBeNull()
    expect(pickedRunTarget("@mars", targets)).toBeNull()
    const off = buildRunTargets({ ...base, problems: { ...ok, box: "no key" } })
    expect(pickedRunTarget("@box", off)).toBeNull()
  })
})

describe("turnPick", () => {
  const box = { runsOn: { value: "box", token: "box", label: "Upstash box" } }
  it("enforces one pick, or none when the turn's messages disagree", () => {
    expect(turnPick([null, box])?.value).toBe("box")
    expect(turnPick([box, box])?.value).toBe("box")
    expect(turnPick([box, { runsOn: { value: "local", token: "local", label: "This computer" } }])).toBeNull()
    expect(turnPick([{}, null])).toBeNull()
  })
})

describe('"!" harness picks', () => {
  const both = buildHarnessTargets({ problems: { claude: null, codex: null, cursor: null } })

  it("lists only the CLIs that can run there; a blocked CLI stays visible", () => {
    expect(both.map((t) => [t.token, t.value, t.label, t.disabled])).toEqual([
      ["claude", "claude", "Claude Code", null],
      ["codex", "codex", "Codex", null],
      ["cursor", "cursor", "Cursor", null],
    ])
    expect(both[0]!.detail).toBe("opus · sonnet · haiku")
    expect(buildHarnessTargets({ problems: { claude: null, codex: "Codex isn't installed", cursor: "cursor-agent isn't installed" } }).map((t) => t.token)).toEqual(["claude"])
    const ssh = buildHarnessTargets({ problems: { claude: null, codex: "x", cursor: "x" }, blocked: { codex: "Codex is unavailable here" } })
    expect(ssh.find((t) => t.token === "codex")?.disabled).toBe("Codex is unavailable here")
  })

  it('"!" opens only at the start of a word, and a draft\'s last "!token" is its pick', () => {
    expect(mentionAt("great!", 6, "!")).toBeNull()
    expect(mentionAt("do it !co", 9, "!")).toEqual({ start: 6, end: 9, query: "co" })
    expect(mentionAt("do it !co", 9, "@")).toBeNull()
    expect(insertRunTarget("do it !co", { start: 6, end: 9 }, "codex", "!")).toEqual({ value: "do it !codex ", caret: 13 })
    expect(pickedRunTarget("wow! use !claude, then !codex.", both, "!")?.token).toBe("codex")
    expect(pickedRunTarget("me@box !box", both, "!")).toBeNull()
  })

  it("a button rewrites the draft's token, or takes it out for Default", () => {
    const places = buildRunTargets(base)
    expect(replacePickToken("run @box now", places, "@", "local")).toBe("run @local now")
    expect(replacePickToken("run @box now", places, "@", null)).toBe("run now")
    expect(replacePickToken("run it @box", places, "@", null)).toBe("run it")
    expect(replacePickToken("@box run it", places, "@", null)).toBe("run it")
    expect(replacePickToken("run it", places, "@", "box")).toBeNull()
    expect(replacePickToken("go !claude.", both, "!", "codex")).toBe("go !codex.")
  })

  it("keeps a message's picks apart, and a turn agrees on each kind", () => {
    const codex = { value: "codex", token: "codex", label: "Codex" }
    expect(runTargetPickOf({ agent: codex }, "agent")).toEqual(codex)
    expect(runTargetPickOf({ agent: { value: "gpt", token: "gpt" } }, "agent")).toBeNull()
    expect(runTargetPickOf({ agent: codex })).toBeNull()
    const box = { value: "box", token: "box", label: "Upstash box" }
    expect(turnPicks([{ runsOn: box }, { agent: codex }])).toEqual({ runsOn: box, agent: codex })
    expect(turnPicks([{ agent: codex }, { agent: { value: "claude", token: "claude", label: "Claude Code" } }]).agent).toBeNull()
  })

  it("explains a blocked harness for the selected machine", () => {
    const ssh = buildHarnessTargets({ problems: { claude: null, codex: "x", cursor: "x" }, blocked: { codex: "Codex is unavailable here" } })
    const air = buildRunTargets({ ...base, machines: [{ name: "air", labels: [] }] }).find((t) => t.token === "air")!
    expect(pickConflict(air, ssh[1]!)).toBe("Codex is unavailable here (you picked @air): pick another place, or another harness.")
    expect(pickConflict(air, ssh[0]!)).toBeNull()
    expect(pickConflict(null, null)).toBeNull()
  })
})

describe("what Default means in a Captain's chat", () => {
  const machines = [{ name: "tower", labels: ["gpu"], state: "ready" as const }]

  it("finds the project's own Runs on in its Captain's list", () => {
    const list = buildRunTargets({ ...base, machines })
    expect(projectRunTarget(list, "box", null)).toMatchObject({ token: "box", label: "Upstash box", disabled: null })
    expect(projectRunTarget(list, "local", null)).toMatchObject({ token: "local", label: "This computer" })
    expect(projectRunTarget(list, "ssh", "Tower")).toMatchObject({ token: "tower", label: "tower" })
    expect(projectRunTarget(list, "ssh", "gpu")).toMatchObject({ token: "label:gpu", label: "Machines labelled gpu" })
    expect(projectRunTarget(list, "ssh", null)).toMatchObject({ token: "ssh", label: "Any SSH machine" })
  })

  it("keeps a project on this computer there when Local means SSH machines", () => {
    const list = buildRunTargets({ ...base, machines, localLabel: "gpu" })
    expect(projectRunTarget(list, "local", null)).toMatchObject({ token: "this-computer", label: "This computer" })
  })

  it("says where while the list loads, and why when the list leaves the runner out", () => {
    expect(projectRunTarget(undefined, "gpu", null)).toMatchObject({ token: "gpu", label: "GPU", disabled: null })
    expect(projectRunTarget(undefined, "local", null)).toMatchObject({ token: "local", value: "this_computer", label: "This computer" })
    // Docker leaves the list while it can't run.
    const list = buildRunTargets({ ...base, problems: { ...ok, docker: "Docker isn't running" } })
    expect(projectRunTarget(list, "docker", null)).toMatchObject({ label: "Docker container", disabled: "Docker container can't run these tasks now" })
    expect(projectRunTarget(list, "ssh", "laptops")).toMatchObject({ kind: "label", label: "SSH machines labelled laptops", disabled: "SSH machines labelled laptops can't run these tasks now" })
  })

  it("names the project's agent, and says so when it isn't set up where the tasks run", () => {
    const both = buildHarnessTargets({ problems: { claude: null, codex: null, cursor: null } })
    expect(projectHarnessTarget(both, "codex")).toMatchObject({ token: "codex", label: "Codex", disabled: null })
    expect(projectHarnessTarget(undefined, "claude")).toMatchObject({ token: "claude", label: "Claude Code", disabled: null })
    const claudeOnly = buildHarnessTargets({ problems: { claude: null, codex: "not signed in", cursor: "not signed in" } })
    expect(projectHarnessTarget(claudeOnly, "codex").disabled).toBe("Codex isn't set up where these tasks run")
  })
})

describe('the Coordinator\'s "%" project picks', () => {
  const projects = buildProjectTargets([
    { id: "prj_1", name: "box-yard", repo: "acme/box-yard" },
    { id: "prj_2", name: "Mobile App" },
    { id: "prj_3", name: "Docs / Site" },
  ])

  it("lists the projects as %tokens a word can hold, the id as the value", () => {
    expect(projects.map((t) => [t.token, t.value, t.kind, t.label, t.detail])).toEqual([
      ["box-yard", "prj_1", "project", "box-yard", "acme/box-yard"],
      ["mobile-app", "prj_2", "project", "Mobile App", null],
      ["docs-site", "prj_3", "project", "Docs / Site", null],
    ])
    expect(projectToken("  !!! ")).toBe("project")
  })

  it('"%" opens only at the start of a word: headings, "%%" and "C%" stay text', () => {
    expect(mentionAt("fix %bo", 7, "%")).toMatchObject({ start: 4, query: "bo" })
    expect(mentionAt("%", 1, "%")).toMatchObject({ start: 0, query: "" })
    expect(mentionAt("% Plan", 6, "%")).toBeNull()
    expect(mentionAt("%% Plan", 2, "%")).toBeNull()
    expect(mentionAt("C%", 2, "%")).toBeNull()
  })

  it("matches loosely: prefix, then contains, then the letters in order, closest first", () => {
    expect(filterRunTargets(projects, "mob", true).map((t) => t.token)).toEqual(["mobile-app"])
    expect(filterRunTargets(projects, "site", true).map((t) => t.token)).toEqual(["docs-site"])
    expect(filterRunTargets(projects, "bxyd", true).map((t) => t.token)).toEqual(["box-yard"])
    // The @ and ! lists stay exact.
    expect(filterRunTargets(projects, "bxyd").map((t) => t.token)).toEqual([])
  })

  it("a draft's last %token that names a project is its pick, and it goes back into the text", () => {
    expect(pickedRunTarget("for %mobile-app and %box-yard", projects, "%")?.value).toBe("prj_1")
    expect(pickedRunTarget("see %123", projects, "%")).toBeNull()
    const m = mentionAt("fix %mo", 7, "%")!
    expect(insertRunTarget("fix %mo", m, "mobile-app", "%")).toEqual({ value: "fix %mobile-app ", caret: 16 })
  })

  it("is checked on the server, and the Coordinator's prompt says to route the message to that Captain", () => {
    expect(() => resolveProjectPick(undefined, "prj_nope")).toThrow(/isn't one of your projects/)
    const pick = resolveProjectPick({ id: "prj_2", name: "Mobile App" }, "prj_2")
    expect(pick).toEqual({ value: "prj_2", token: "mobile-app", label: "Mobile App" })
    const note = projectNote(pick, "Sam")
    expect(note).toContain('[Sam picked the project for this message: %mobile-app, project "Mobile App" (prj_2).')
    expect(note).toContain('send_to_captain (project "prj_2")')
    expect(note).not.toContain("Cody")
    // Before the @ and ! lines, each on its own line.
    const lines = pickNotes({ project: pick, runsOn: { value: "box", token: "box", label: "Upstash box" } }, "Sam", false).split("\n")
    expect(lines[1]).toMatch(/^\[Sam picked the project/)
    expect(lines[2]).toMatch(/^\[Sam picked where tasks run/)
    expect(pickNotes({}, "Sam", false)).toBe("")
  })
})

describe("picks for only part of a message (scopePicks)", () => {
  const places = buildRunTargets(base)
  const harnesses = buildHarnessTargets({ problems: { claude: null, codex: null, cursor: null } })
  const projects = buildProjectTargets([
    { id: "prj_yard", name: "Box Yard" },
    { id: "prj_castle", name: "Keep the Castle" },
  ])
  /** Every typed pick in `text`, as the composer finds them. */
  const placed = (text: string): PlacedPick[] => [
    ...tokensIn(text, places, "@", true).map((p) => ({ ...p, kind: "runsOn" as const })),
    ...tokensIn(text, harnesses, "!", true).map((p) => ({ ...p, kind: "agent" as const })),
    ...tokensIn(text, projects, "%").map((p) => ({ ...p, kind: "project" as const })),
  ]
  const scope = (text: string) => scopePicks(text, placed(text))
  const wideTokens = (text: string) => {
    const { wide } = scope(text)
    return { runsOn: wide.runsOn?.token ?? null, agent: wide.agent?.token ?? null, project: wide.project?.token ?? null }
  }

  // The message that went wrong: most items say Codex in words, item 9 says !claude, and @box sits on top.
  const TEN = [
    "@box Ten tasks across two projects:",
    "1. Keep the Castle: raise the drawbridge, use Codex gpt-6.1-sol xhigh",
    "2. Keep the Castle: new loading screens, use Codex gpt-6.1-sol xhigh",
    "   - one per level",
    "3. Keep the Castle: inventory chip, use Codex gpt-6.1-sol xhigh",
    "9. Box Yard: inline picks apply to their part !claude",
    "10. Box Yard: task info modal, use Codex gpt-6.1-sol xhigh",
    "",
    "Thanks!",
  ].join("\n")

  it("finds a message's list items, with sub-lists inside their item and the text after the list outside it", () => {
    const items = listItems(TEN)
    expect(items.map((i) => i.label)).toEqual(["item 1", "item 2", "item 3", "item 9", "item 10"])
    expect(TEN.slice(items[1]!.start, items[1]!.end)).toBe("2. Keep the Castle: new loading screens, use Codex gpt-6.1-sol xhigh\n   - one per level")
    expect(TEN.slice(items[4]!.start, items[4]!.end)).not.toContain("Thanks")
    expect(listItems("- a\n- b\n* c").map((i) => i.label)).toEqual(["bullet 1", "bullet 2", "bullet 3"])
    expect(listItems("(1) a\n(2) b").map((i) => i.label)).toEqual(["item 1", "item 2"])
    expect(listItems("Ship it @box, then rest.")).toEqual([])
    expect(listItems("1.5 GB is the cap")).toEqual([])
  })

  it("one inline pick in a list of tasks is only its item's: the message's own pick still applies", () => {
    const s = scope(TEN)
    expect(wideTokens(TEN)).toEqual({ runsOn: "box", agent: null, project: null })
    expect(s.picks.map((p) => [p.target.token, p.scope, p.reason, p.item?.label ?? null])).toEqual([
      ["box", "message", null, null],
      ["claude", "inline", "item", "item 9"],
    ])
    expect(inlinePicksFrom(TEN, s)).toEqual([
      { kind: "agent", value: "claude", token: "claude", label: "Claude Code", where: 'item 9 ("Box Yard: inline picks apply to their part")', reason: "item" },
    ])
  })

  it("several different picks force nothing: each goes with where it is", () => {
    const text = "1. Port the pickaxe !codex @box\n2. Fix the bridge !claude @local\n3. Tidy up"
    expect(wideTokens(text)).toEqual({ runsOn: null, agent: null, project: null })
    expect(inlinePicksFrom(text, scope(text)).map((p) => [p.kind, p.token, p.where])).toEqual([
      ["agent", "codex", 'item 1 ("Port the pickaxe")'],
      ["runsOn", "box", 'item 1 ("Port the pickaxe")'],
      ["agent", "claude", 'item 2 ("Fix the bridge")'],
      ["runsOn", "local", 'item 2 ("Fix the bridge")'],
    ])
    // Two that differ outside any list: neither is the message's.
    const mixed = "Run the port @box and the review @local"
    expect(wideTokens(mixed).runsOn).toBeNull()
    expect(scope(mixed).picks.map((p) => p.reason)).toEqual(["mixed", "mixed"])
  })

  it("a pick over the list is the whole message's, unless an item names another of its kind", () => {
    expect(wideTokens("!codex for all of these:\n1. A\n2. B").agent).toBe("codex")
    // An item naming the same one again is covered by it.
    expect(wideTokens("!codex for all of these:\n1. A !codex\n2. B").agent).toBe("codex")
    const exception = "!codex for all of these:\n1. A\n2. B !claude"
    expect(wideTokens(exception).agent).toBeNull()
    expect(scope(exception).picks.map((p) => [p.target.token, p.reason])).toEqual([
      ["codex", "mixed"],
      ["claude", "item"],
    ])
  })

  it("a single task's picks are the whole message's, wherever they're typed (the picker's, as before)", () => {
    expect(wideTokens("@box !codex fix the login bug")).toEqual({ runsOn: "box", agent: "codex", project: null })
    expect(wideTokens("Fix the login bug.\n\nIt fails on Safari. @local !cursor")).toEqual({ runsOn: "local", agent: "cursor", project: null })
    // A list of one item is still one task.
    expect(wideTokens("- fix the login bug !claude").agent).toBe("claude")
    expect(wideTokens("@box @box ship it").runsOn).toBe("box")
  })

  it("a harness pick whose message asks for another in words isn't the message's", () => {
    const text = "!claude review the port, but use Codex gpt-6.1-sol xhigh for the port itself"
    expect(wideTokens(text).agent).toBeNull()
    expect(scope(text).picks[0]).toMatchObject({ scope: "inline", reason: "words" })
    expect([...harnessesInWords(text, placed(text))]).toEqual(["codex"])
    expect([...harnessesInWords("run it on Cursor")]).toEqual(["cursor"])
    expect([...harnessesInWords("try claude-opus-5-5 then o3")].sort()).toEqual(["claude", "codex"])
    // Its own name, a bare model word or a CLI named in passing don't count.
    expect(wideTokens("!codex use Codex gpt-6.1-sol").agent).toBe("codex")
    expect(harnessesInWords("write a haiku about the Composer in the Codex picker").size).toBe(0)
    expect(wideTokens("@box ship it, using Codex if you like").runsOn).toBe("box")
  })

  it('scopes the Coordinator\'s "%" the same way: a project per item is a hint for that item', () => {
    const text = "1. Fix the drawbridge %keep-the-castle\n2. Scope the picks %box-yard"
    expect(wideTokens(text).project).toBeNull()
    expect(inlinePicksFrom(text, scope(text)).map((p) => [p.kind, p.value, p.where])).toEqual([
      ["project", "prj_castle", 'item 1 ("Fix the drawbridge")'],
      ["project", "prj_yard", 'item 2 ("Scope the picks")'],
    ])
    expect(wideTokens("what's open? %box-yard").project).toBe("box-yard")
  })

  it("tells a harness's models and efforts apart: one item's model is only that item's", () => {
    const models = harnessModelTargets(harnesses, { defaults: harnessDefaults(), cursor: [] })
    const placedModels = (text: string): PlacedPick[] => tokensIn(text, models, "!", true).map((p) => ({ ...p, kind: "agent" as const }))
    const text = "!codex for all of these:\n1. A !codex:gpt-6.1-sol:xhigh\n2. B"
    const s = scopePicks(text, placedModels(text))
    expect(s.wide.agent).toBeNull()
    expect(inlinePicksFrom(text, s).map((p) => [p.token, p.model ?? null, p.effort ?? null, p.reason])).toEqual([
      ["codex", null, null, "mixed"],
      ["codex:gpt-6.1-sol:xhigh", "gpt-6.1-sol", "xhigh", "item"],
    ])
    expect(itemExcerpt(text, listItems(text)[0]!)).toBe("A")
    const codex = { value: "codex", token: "codex", label: "Codex" }
    const item = { kind: "agent", ...codex, token: "codex:gpt-6.1-sol", model: "gpt-6.1-sol", where: "item 1", reason: "item" }
    expect(turnPick([{ agent: codex, inlinePicks: [item] }], "agent")).toBeNull()
    expect(inlinePicksOf({ inlinePicks: [item] })).toEqual([item])
    expect(pickNotes({ inlinePicks: [item] }, "Sam", false)).toContain('!codex:gpt-6.1-sol (Codex, agent "codex", model "gpt-6.1-sol") in item 1')
  })

  it("a turn applies no pick an inline one in it disagrees with", () => {
    const codex = { value: "codex", token: "codex", label: "Codex" }
    const claudeInItem = { kind: "agent", value: "claude", token: "claude", label: "Claude Code", where: "item 9", reason: "item" }
    expect(turnPick([{ agent: codex, inlinePicks: [claudeInItem] }], "agent")).toBeNull()
    expect(turnPick([{ agent: codex }, { inlinePicks: [claudeInItem] }], "agent")).toBeNull()
    expect(turnPick([{ agent: codex, inlinePicks: [{ ...claudeInItem, value: "codex", token: "codex" }] }], "agent")).toEqual(codex)
    // Another kind's inline pick doesn't matter.
    expect(turnPick([{ agent: codex, inlinePicks: [{ ...claudeInItem, kind: "runsOn", value: "local" }] }], "agent")).toEqual(codex)
    expect(inlinePicksOf({ inlinePicks: [claudeInItem, { kind: "agent", value: "gpt", token: "gpt" }, null, "x"] })).toEqual([claudeInItem])
  })

  it("the turn's prompt lists them with where they are, and says Box Yard applies none", () => {
    const inline = inlinePicksFrom(TEN, scope(TEN))
    const lines = pickNotes({ runsOn: { value: "box", token: "box", label: "Upstash box" }, inlinePicks: inline }, "Sam", true).split("\n")
    expect(lines[1]).toMatch(/^\[Sam picked where tasks run for this message: @box/)
    expect(lines[2]).toBe(
      '[Sam typed picks for only part of this message, so Box Yard applies none of them to this turn: !claude (Claude Code, agent "claude") in item 9 ("Box Yard: inline picks apply to their part"). ' +
        "Pass each yourself, on the create_task call or create_tasks item for the task it's written with (a \"%\" one: send that part to its project's Captain), and follow the message's own words for the rest: the agent, model, effort and runs_on you pass are what each task gets. " +
        "When you send such a part to a Captain, say its pick in your message: Box Yard doesn't carry these to Captains.]",
    )
    // A Captain's prompt has no relay sentence.
    expect(pickNotes({ inlinePicks: inline }, "Sam", false)).not.toContain("Box Yard doesn't carry these")
    expect(pickNotes({ inlinePicks: [{ ...inline[0]!, where: null, reason: "words" }] }, "Sam", false)).toContain("outside any list item, though the message's words ask for another harness")
  })

  it("a whole-message pick its own hints disagree with is listed with them, never as picked: a \"%\" one too", () => {
    const mobile = { value: "prj_mobile", token: "mobile", label: "Mobile" }
    const web = { kind: "project" as const, value: "prj_web", token: "web", label: "Web", where: 'item 2 ("Tidy the header")', reason: "item" as const }
    const notes = pickNotes({ project: mobile, inlinePicks: [web] }, "Sam", true)
    // The "%" line is all a project pick does: with an item's other project, no "route it all to %mobile's Captain".
    expect(notes).not.toContain("[Sam picked the project")
    expect(notes).toContain(
      '[Sam typed picks for only part of this message, so Box Yard applies none of them to this turn: %mobile (Mobile, project "prj_mobile") outside any list item, with another of its kind in the message; %web (Web, project "prj_web") in item 2 ("Tidy the header").',
    )
    // One that agrees stays the message's.
    expect(pickNotes({ project: mobile, inlinePicks: [{ ...web, ...mobile }] }, "Sam", true)).toMatch(/^\n\[Sam picked the project for this message: %mobile/)
    // The same for "@": the line says what turnPick does.
    const where = pickNotes({ runsOn: { value: "box", token: "box", label: "Upstash box" }, inlinePicks: [{ ...web, kind: "runsOn", value: "local", token: "local", label: "This computer" }] }, "Sam", true)
    expect(where).not.toContain("[Sam picked where tasks run")
    expect(where).toContain('@box (Upstash box, runs_on "box") outside any list item, with another of its kind in the message; @local')
  })
})

describe("named runner sizes", () => {
  const targets = buildRunTargets({ ...base, gpu: { default: "runpod", problems: { runpod: null, vast: null, daytona: null }, types: { runpod: [], vast: [], daytona: [] } } })
  it("drills into Upstash sizes and accepts colon and hyphen spellings as the same complete token", () => {
    expect(filterRunTargets(targets, "box").map((t) => t.token)).toEqual(["box", "box:small", "box:medium", "box:large"])
    expect(filterRunTargets(targets, "box-").map((t) => t.token)).toEqual(["box:small", "box:medium", "box:large"])
    expect(drillsInto(targets.find((t) => t.token === "box")!, targets, "bo")).toBe(true)
    for (const size of ["small", "medium", "large"]) {
      const pick = pickedRunTarget(`use @box-${size}`, targets)
      expect(pick?.value).toBe(`box:${size}`)
      expect(pickedRunTarget(`use @box:${size}.`, targets)).toEqual(pick)
    }
    expect(pickedRunTarget("@box-medium-ish", targets)).toBeNull()
    expect(pickedRunTarget("@box:giant", targets)).toBeNull()
    expect(replacePickToken("use @box-medium please", targets, "@", "box:large")).toBe("use @box:large please")
  })
  it("keeps machine names from shadowing a size alias", () => {
    const list = buildRunTargets({ ...base, machines: [{ name: "box-medium", labels: [] }] })
    expect(pickedRunTarget("@box-medium", list)?.value).toBe("box:medium")
    expect(pickedRunTarget("@label:box-medium", list)?.value).toBe("label:box-medium")
  })
  it("lists Daytona CPU sizes and GPU machine types, preserving other clouds' GPU picks", () => {
    const sizes = filterRunTargets(targets, "daytona:")
    // The shared drill-down (shared/harnessPicks.ts too): the provider's own default first, then its sizes.
    expect(filterRunTargets(targets, "daytona")[0]).toMatchObject({ token: "daytona", menuLabel: "Default machine" })
    expect(filterRunTargets(targets, "box")[0]).toMatchObject({ token: "box", menuLabel: "Default size" })
    expect(sizes.map((t) => t.value)).toEqual(expect.arrayContaining(["daytona:cpu-small", "daytona:cpu-standard", "daytona:cpu-large", "daytona:gpu-h100"]))
    expect(pickedRunTarget("@daytona-medium", targets)?.value).toBe("daytona:cpu-standard")
    expect(pickedRunTarget("@gpu:daytona:cpu-large", targets)?.value).toBe("daytona:cpu-large")
    expect(pickedRunTarget("@gpu:runpod:rtx-a5000", targets)?.value).toBe("gpu:runpod:rtx-a5000")
    expect(pickedRunTarget("@gpu:vast:rtx-4090", targets)?.value).toBe("gpu:vast:rtx-4090")
  })
})
