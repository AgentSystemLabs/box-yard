// Pure helpers for the settings dialog: its categories, the `?settings=` deep link, and unsaved-change tracking.
import type { Settings } from "../../../shared/types"

export type SettingsSection = "orchestrator" | "projects" | "agents" | "runners" | "local" | "upstash" | "credentials" | "identities" | "connectors" | "runpod" | "vast" | "daytona" | "docker" | "machines" | "hooks" | "limits" | "costs" | "notifications" | "voice" | "appearance" | "about"

export interface SectionInfo {
  key: SettingsSection
  label: string
  description: string
  parent?: "runners"
  group?: "GPU clouds"
  /** The settings edited in this section; drives the unsaved-changes dot in the nav. */
  fields: (keyof Settings)[]
}

export const SETTINGS_SECTIONS: SectionInfo[] = [
  {
    key: "orchestrator",
    label: "Coordinator",
    description: "The Coordinator chat and every project's Captain: agent, model, icon, notes, compaction, merges.",
    fields: [
      "orchestratorCli",
      "orchestratorModel",
      "orchestratorCodexModel",
      "orchestratorEffort",
      "orchestratorAutoCompact",
      "orchestratorRelay",
      "captainCli",
      "captainModel",
      "captainCodexModel",
      "captainEffort",
      "captainIcon",
      "quickQuestionModel",
      "quickQuestionEffort",
      "notesRetroEnabled",
      "notesMaxCount",
      "notesMaxTokens",
      "autoDoneOnMerge",
      "closeIssuesOnMerge",
    ],
  },
  {
    key: "projects",
    label: "Projects",
    description: "Each project's repo, env vars, identity, runner and limits, in its own form.",
    fields: [],
  },
  {
    key: "agents",
    label: "Box agents",
    description: "Defaults for the agents that work on tasks: Claude Code, Codex, Cursor or OpenCode.",
    fields: ["ownerName", "agentCli", "agentModel", "agentCodexModel", "agentCursorModel", "agentOpencodeModel", "agentCodexEffort", "agentEffort", "agentRoutingConfig", "agentAutoCompact", "subtaskMaxDepth", "subtaskMaxChildren"],
  },
  {
    key: "runners",
    label: "Box providers",
    description: "Where new projects run, the Default GPU cloud, and each provider's own settings.",
    fields: ["gpuProvider"],
  },
  {
    key: "local",
    label: "This computer",
    parent: "runners",
    description: "Tools and logins for tasks running directly on this computer.",
    fields: [],
  },
  {
    key: "upstash",
    label: "Upstash boxes",
    parent: "runners",
    description: "Isolated cloud boxes: the key, box size, resizing, and tasks per box.",
    fields: ["workerSize", "autoResizeEnabled", "autoResizeMaxSize", "placementResizeEnabled", "slotsPerBox", "maxResidentPerBox"],
  },
  {
    key: "credentials",
    label: "Credentials",
    description: "Claude, Codex, Cursor, OpenCode and GitHub logins, kept on this server and never sent back.",
    fields: [],
  },
  {
    key: "identities",
    label: "Identities",
    description: "Who each project acts as on GitHub: account, git author, signing key, Claude login.",
    fields: [],
  },
  {
    key: "connectors",
    label: "Connectors",
    description: "Other MCP servers, like Gmail, Notion or Linear, and who gets them.",
    fields: [],
  },
  {
    key: "docker",
    parent: "runners",
    label: "Docker",
    description: "Isolated containers on this computer, one per project, stopped when idle.",
    fields: [],
  },
  {
    key: "daytona",
    parent: "runners",
    label: "Daytona",
    description: "Managed cloud sandboxes, CPU only or with a GPU, billed per second.",
    fields: [],
  },
  {
    key: "machines",
    parent: "runners",
    label: "SSH machines",
    description: "Your own computers, reached over SSH. Agents there aren't sandboxed.",
    fields: [],
  },
  {
    key: "runpod",
    parent: "runners",
    group: "GPU clouds",
    label: "RunPod GPU",
    description: "A GPU pod per project, started when a task needs it and stopped when idle.",
    fields: [],
  },
  {
    key: "vast",
    parent: "runners",
    group: "GPU clouds",
    label: "Vast.ai GPU",
    description: "Vast.ai's GPU marketplace: more GPU types, often cheaper, hosts vary.",
    fields: [],
  },
  {
    key: "hooks",
    label: "Hooks",
    description: "Global hooks: automations the Coordinator runs on every project's task events.",
    fields: [],
  },
  {
    key: "limits",
    label: "Boxes & limits",
    description: "The box pool, tasks at once, disk and memory headroom, cleanup, mirrors and git pushes.",
    fields: [
      "maxBoxes",
      "boxCreateConcurrency",
      "maxAgents",
      "localAgents",
      "localFoldersKept",
      "localBuildCleanup",
      "localDiskMinFreeGb",
      "boxIdleDeleteMinutes",
      "workspaceRetentionDays",
      "archiveRetentionDays",
      "archiveKeepTouchedDays",
      "diskMinFreeMb",
      "diskCloneFactor",
      "memoryMaxUsedPercent",
      "memoryMinFreeMb",
      "loadMaxPerCpu",
      "buildCleanupIdleMinutes",
      "depCacheEnabled",
      "depCacheMaxMb",
      "gitPartialClone",
      "gitPushAtTurnEnd",
    ],
  },
  {
    key: "costs",
    label: "Usage",
    description: "Open Usage for allowances and costs; below, box spending limits, the spend meter and rates.",
    fields: ["showCloudMeter", "costRates", "budget"],
  },
  {
    key: "notifications",
    label: "Notifications",
    description: "How this browser tells you a task finished or needs you, and the send sound.",
    fields: [],
  },
  {
    key: "voice",
    label: "Voice",
    description: "Spoken updates when work finishes, and push-to-talk dictation in message boxes.",
    fields: [],
  },
  {
    key: "appearance",
    label: "Appearance",
    description: "How Box Yard looks in this browser.",
    fields: [],
  },
  { key: "about", label: "About", description: "What this Box Yard is running on.", fields: [] },
]

/** One hierarchy drives navigation, provider groups and search breadcrumbs. Leaf IDs keep old deep links working. */
export const SETTINGS_TOP_SECTIONS = SETTINGS_SECTIONS.filter((s) => !s.parent)
export const RUNNER_SECTIONS = SETTINGS_SECTIONS.filter((s) => s.parent === "runners")
export function settingsRoot(section: SettingsSection): SettingsSection {
  return SETTINGS_SECTIONS.find((s) => s.key === section)!.parent ?? section
}
export function settingsPath(section: SettingsSection): string[] {
  const info = SETTINGS_SECTIONS.find((s) => s.key === section)!
  return [...(info.parent ? [SETTINGS_SECTIONS.find((s) => s.key === info.parent)!.label] : []), ...(info.group ? [info.group] : []), info.label]
}

/** The URL query param that opens the dialog, e.g. `?settings=limits`. */
export const SETTINGS_PARAM = "settings"
export const DEFAULT_SECTION: SettingsSection = "orchestrator"

/** Other words for a section, in `?settings=` links and the command palette. */
export const ALIASES: Record<string, SettingsSection> = { theme: "appearance", display: "appearance", runner: "runners", where: "runners", providers: "runners", identity: "identities", accounts: "identities", connector: "connectors", mcp: "connectors", oauth: "connectors", integrations: "connectors", gmail: "connectors", signing: "identities", keys: "credentials", credential: "credentials", setup: "credentials", tokens: "credentials", hook: "hooks", automations: "hooks", boxes: "limits", agent: "agents", workers: "agents", cost: "costs", usage: "costs", budget: "costs", spend: "costs", meter: "costs", speech: "voice", tts: "voice", gpu: "runners", gpus: "runners", default: "runners", vastai: "vast", "vast.ai": "vast", sandbox: "daytona", sandboxes: "daytona", container: "docker", containers: "docker" }

/** The section a `?settings=` value points at; unknown or empty values fall back to the first one. */
export function parseSection(value: string | null | undefined): SettingsSection {
  const v = (value ?? "").trim().toLowerCase()
  if (SETTINGS_SECTIONS.some((s) => s.key === v)) return v as SettingsSection
  return ALIASES[v] ?? DEFAULT_SECTION
}

/** The tab `delta` steps away from `current` in `keys`, wrapping around (↑/↓ in a settings nav, SettingsTabs.tsx). */
export function stepTab<K>(keys: readonly K[], current: K, delta: number): K {
  const i = keys.indexOf(current)
  const n = keys.length
  return keys[(((i + delta) % n) + n) % n]!
}

/** The top-level section `delta` steps away from `current`'s, wrapping around. */
export function stepSection(current: SettingsSection, delta: number): SettingsSection {
  return stepTab(SETTINGS_TOP_SECTIONS.map((s) => s.key), settingsRoot(current), delta)
}

/** Env vars that can supply a setting, shown next to "from env". */
export const SETTING_ENV: Partial<Record<keyof Settings, string>> = {
  ownerName: "BOXYARD_OWNER_NAME",
  orchestratorModel: "ORCHESTRATOR_MODEL",
  captainModel: "CAPTAIN_MODEL",
  captainEffort: "CAPTAIN_EFFORT",
  agentModel: "WORKER_MODEL",
  workerSize: "WORKER_SIZE",
  maxBoxes: "BOX_POOL_MAX",
  boxCreateConcurrency: "BOX_CREATE_CONCURRENCY",
  slotsPerBox: "BOX_SLOTS",
  maxAgents: "BOX_MAX_AGENTS",
  localAgents: "BOXYARD_LOCAL_AGENTS",
  localFoldersKept: "BOXYARD_LOCAL_FOLDERS_KEPT",
  localBuildCleanup: "BOXYARD_LOCAL_BUILD_CLEANUP",
  localBuildCleanupIdleHours: "BOXYARD_LOCAL_BUILD_CLEANUP_IDLE_HOURS",
  localDiskMinFreeGb: "BOXYARD_LOCAL_DISK_MIN_FREE_GB",
  maxResidentPerBox: "BOX_MAX_RESIDENT",
  boxIdleDeleteMinutes: "BOX_IDLE_DELETE_MINUTES",
  workspaceRetentionDays: "BOXYARD_WORKSPACE_RETENTION_DAYS",
  archiveRetentionDays: "BOXYARD_ARCHIVE_RETENTION_DAYS",
  archiveKeepTouchedDays: "BOXYARD_ARCHIVE_KEEP_TOUCHED_DAYS",
  diskMinFreeMb: "BOXYARD_DISK_MIN_FREE_MB",
  diskCloneFactor: "BOXYARD_DISK_CLONE_FACTOR",
  memoryMaxUsedPercent: "BOXYARD_MEMORY_MAX_USED_PERCENT",
  memoryMinFreeMb: "BOXYARD_MEMORY_MIN_FREE_MB",
  loadMaxPerCpu: "BOXYARD_LOAD_MAX_PER_CPU",
  buildCleanupIdleMinutes: "BOXYARD_BUILD_CLEANUP_IDLE_MINUTES",
  gitPartialClone: "BOXYARD_GIT_PARTIAL_CLONE",
  gitPushAtTurnEnd: "BOXYARD_GIT_PUSH_AT_TURN_END",
  notesMaxCount: "BOXYARD_NOTES_MAX",
  notesMaxTokens: "BOXYARD_NOTES_MAX_TOKENS",
}

/** Settings whose draft value differs from the one in effect. */
export function changedKeys(draft: Settings | null | undefined, current: Settings | null | undefined): (keyof Settings)[] {
  if (!draft || !current) return []
  return (Object.keys(draft) as (keyof Settings)[]).filter((k) => JSON.stringify(draft[k]) !== JSON.stringify(current[k]))
}

/** Sections holding at least one of `keys`. */
export function changedSections(keys: (keyof Settings)[]): Set<SettingsSection> {
  return new Set(SETTINGS_SECTIONS.filter((s) => s.fields.some((f) => keys.includes(f))).map((s) => s.key))
}

const POOL_KEYS = [
  "workerSize",
  "autoResizeEnabled",
  "autoResizeMaxSize",
  "placementResizeEnabled",
  "maxBoxes",
  "boxCreateConcurrency",
  "slotsPerBox",
  "maxAgents",
  "localAgents",
  "localFoldersKept",
  "localBuildCleanup",
  "localBuildCleanupIdleHours",
  "localDiskMinFreeGb",
  "maxResidentPerBox",
  "boxIdleDeleteMinutes",
  "workspaceRetentionDays",
  "archiveRetentionDays",
  "archiveKeepTouchedDays",
  "diskMinFreeMb",
  "diskCloneFactor",
  "memoryMaxUsedPercent",
  "memoryMinFreeMb",
  "loadMaxPerCpu",
  "buildCleanupIdleMinutes",
  "gitPartialClone",
  "gitPushAtTurnEnd",
] as const

/**
 * What Save sends. Pool limits (and the resize guardrails) go only when edited, so an untouched form doesn't pin them
 * over env changes. `keep` names fields typed in on purpose even if the value matches what's in effect (a box limit
 * typed over the size default).
 */
export function savePatch(draft: Settings, current: Settings | null | undefined, keep: readonly (keyof Settings)[] = []): Partial<Settings> {
  const patch: Partial<Settings> = { ...draft }
  for (const k of POOL_KEYS) if (current && draft[k] === current[k] && !keep.includes(k)) delete patch[k]
  return patch
}
