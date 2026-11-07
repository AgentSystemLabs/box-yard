import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react"
import { useLocation } from "wouter"
import { Bot, Boxes, FolderGit2, GitPullRequest, ImageUp, KeyRound, NotebookPen, ShieldAlert, Trash2, Variable, X } from "lucide-react"
import {
  useAgentSettings,
  useCaptainIconSetting,
  useDeleteProject,
  useDocker,
  useIdentities,
  useMachines,
  useProjectAutoSize,
  useProjects,
  useRunPod,
  useVast,
  useDaytona,
  useRunningTask,
  useSettings,
  useSetup,
  useSetProjectIcon,
  useUpdateProject,
} from "../lib/queries"
import { Button, Field, LineIcon, Select, cx, inputClass, parseEnv } from "./ui"
import { useOpenSettings } from "./SettingsHost"
import { PanelFrame } from "./SettingsBlocks"
import { SettingsTabs, type SettingsTab } from "./SettingsTabs"
import { MachineLabelPicker } from "./MachineSettings"
import { IdentityBadge } from "./IdentityBadge"
import { CLAUDE_CREDENTIAL_VARS, DEFAULT_IDENTITY_ID } from "../../../shared/identities"
import { CREDENTIAL_INFO, type SetupStatus } from "../../../shared/setup"
import { BOX_SIZES, PROJECT_BOX_LIMITS, SIZE_DEFAULTS, WORKER_SIZES, type BoxSize, type Project, type SettingsInfo } from "../../../shared/types"
import { BOX_SIZE_SPECS, sizeSpecLine } from "../../../shared/boxSizes"
import { AUTO_SIZE_MIN_RUNS } from "../../../shared/autoSize"
import { RUNPOD_CLOUDS, RUNPOD_MACHINE_LIMITS, shortGpu, type ProjectGpuMachine, type RunPodCloud } from "../../../shared/runpod"
import { GpuTypePicker } from "./GpuTypePicker"
import { VastGpuPicker } from "./VastSettings"
import { DaytonaGpuPicker } from "./DaytonaSettings"
import { DEFAULT_GPU_PROVIDER, GPU_DEFAULT_PATH, GPU_POD_NOUN, GPU_POD_NOUNS, GPU_PROVIDERS, GPU_PROVIDER_LABEL, GPU_SETTINGS_PATH, effectiveGpuProvider, type GpuProvider } from "../../../shared/gpu"
import { daytonaGpuLabel, daytonaMachine } from "../../../shared/daytona"
import { CLOUD_HELP, CLOUD_OPTION } from "./RunPodSettings"
import { DEFAULT_NOTE_BUDGET, NOTE_BUDGET_LIMITS } from "../../../shared/notes"
import { LOCAL_UNSANDBOXED, RUNNERS, RUNNER_LABEL, RUNNER_PHRASE, type Runner } from "../../../shared/runner"
import { DOCKERFILE_TEMPLATE, type ProjectDocker } from "../../../shared/docker"
import { AGENT_CLIS, AGENT_CLI_LABEL, DEFAULT_AGENT_CLI, type AgentCli } from "../../../shared/agentCli"
import { confirmDialog } from "../lib/confirm"
import { refusedByBrowser } from "../lib/settingsValidation"
import { PROJECT_COLORS, projectColors, type ProjectColor } from "../../../shared/projectColors"
import { PROJECT_ICON_ACCEPT, PROJECT_ICON_MAX_BYTES, PROJECT_ICON_TYPES } from "../../../shared/projectIcons"
import { ProjectAvatar, projectColorStyle } from "./TaskIcon"
import { CaptainGlyph } from "./CaptainIcon"
import { CaptainIconPicker, type CaptainIconDefault } from "./CaptainIconPicker"
import { DEFAULT_CAPTAIN_ICON, captainIconInfo, type CaptainIconId } from "../../../shared/captainIcons"

/** A GPU project's own cloud and machine as the form edits them: "" for a field that uses the global one. */
type MachineDraft = { provider: GpuProvider | ""; gpuTypes: string[] | null; cloud: RunPodCloud | ""; minRamGb: string; minVcpus: string }
const machineDraft = (m: ProjectGpuMachine, provider: GpuProvider | null): MachineDraft => ({
  provider: provider ?? "",
  gpuTypes: m.gpuTypes,
  cloud: m.cloud ?? "",
  minRamGb: m.minRamGb?.toString() ?? "",
  minVcpus: m.minVcpus?.toString() ?? "",
})

/** A project's own on/off over a setting, as a select's value: "" follows Settings. */
const onOff = (v: boolean | null | undefined): "" | "on" | "off" => (v === null || v === undefined ? "" : v ? "on" : "off")

/** A number field's value, or null when it's blank (use the default). */
function optionalInt(text: string): number | null {
  const n = optionalNumber(text)
  return n === null ? null : Math.round(n)
}

function optionalNumber(text: string): number | null {
  const n = Number(text.trim())
  return text.trim() && Number.isFinite(n) ? n : null
}

/** "small 1 · medium 2 · large 4": a box limit that follows each box's size. */
const bySize = (k: "slotsPerBox" | "maxResidentPerBox") => WORKER_SIZES.map((z) => `${z} ${SIZE_DEFAULTS[z][k]}`).join(" · ")

/**
 * Project › Settings › Boxes: the project's own box size, tasks running at once, task folders kept per box and max boxes. Each one left
 * blank uses the global setting (Settings › Boxes & limits), which the field names ("Using global: …"); one that's
 * set has a Use global button that clears it.
 */
function ProjectBoxSettings(p: {
  info: SettingsInfo | undefined
  projectId: string
  /** The project's name, for the line that says what Tasks running at once does. */
  name: string
  local: boolean
  gpu: boolean
  docker: boolean
  ssh: boolean
  boxSize: BoxSize | ""
  setBoxSize: (v: BoxSize | "") => void
  agentsPerBox: string
  setAgentsPerBox: (v: string) => void
  wholeMachine: boolean
  setWholeMachine: (v: boolean) => void
  tasksPerBox: string
  setTasksPerBox: (v: string) => void
  maxBoxes: string
  setMaxBoxes: (v: string) => void
  gpuMaxHourlyUsd: string
  setGpuMaxHourlyUsd: (v: string) => void
  machine: MachineDraft
  setMachine: (v: MachineDraft) => void
}) {
  const openSettings = useOpenSettings()
  const runpod = useRunPod({ enabled: p.gpu })
  const vast = useVast({ enabled: p.gpu })
  const daytona = useDaytona({ enabled: p.gpu })
  const settings = useAgentSettings()
  const m = p.machine
  const setM = (patch: Partial<MachineDraft>) => p.setMachine({ ...m, ...patch })
  // The cloud its new pods come from: its own pick, else Settings › Box providers › Default GPU cloud.
  const globalCloud = settings.data?.settings.gpuProvider ?? DEFAULT_GPU_PROVIDER
  const provider = effectiveGpuProvider(m.provider || null, globalCloud)
  const onVast = provider === "vast"
  const onDaytona = provider === "daytona"
  const pods = GPU_POD_NOUNS[provider]
  const where = GPU_SETTINGS_PATH[provider]
  const rp = runpod.data?.settings
  const dt = daytona.data?.settings
  const g = onVast ? vast.data?.settings : onDaytona ? dt && { ...dt, ...daytonaMachine(dt) } : rp
  const gpuLabel = onDaytona ? daytonaGpuLabel : shortGpu
  const gpuCap = g ? `$${g.maxHourlyUsd}/hr (${where} › Max per project)` : `${where} › Max per project`
  const cloud = m.cloud || rp?.cloud || "SECURE"
  const onBoxes = !p.local && !p.gpu && !p.docker && !p.ssh
  const s = p.info?.settings
  const followsSize = (k: "slotsPerBox" | "maxResidentPerBox") => !p.info || p.info.sources[k] === "default"
  const perBox = (k: "slotsPerBox" | "maxResidentPerBox") => (followsSize(k) || !s ? { long: `each box's size default (${bySize(k)})`, short: "by box size" } : { long: String(s[k]), short: String(s[k]) })
  const agents = perBox("slotsPerBox")
  const folders = perBox("maxResidentPerBox")
  const pool = s ? String(s.maxBoxes) : "the pool's"
  // Box size left blank: auto-sizing's pick from the project's runs (Settings › Size and resize boxes automatically), else Worker size.
  const autoSize = useProjectAutoSize(p.projectId).data
  const worker = s?.workerSize ?? "Settings › Worker size"
  const auto = autoSize?.enabled
    ? autoSize.size
      ? { field: autoSize.label, option: `Auto: ${autoSize.label}` }
      : { field: `${worker} (Worker size) until ${AUTO_SIZE_MIN_RUNS} runs are measured (${autoSize.runs} so far)`, option: `Auto: ${worker} until measured` }
    : null
  return (
    <div className="@container space-y-3" data-testid="project-boxes">
      <p className="text-xs text-zinc-500">
        Leave one blank to use the global setting. Where projects share a box, the strictest Task folders kept per box wins.
        {p.local && " This project runs on this computer: Tasks running at once also limits its tasks here, within Settings › Tasks running at once on this computer, and the rest apply when it runs on boxes."}
        {p.gpu &&
          ` This project runs on ${GPU_PROVIDER_LABEL[provider]} GPU ${pods}: Tasks running at once sets its tasks per ${GPU_POD_NOUN[provider]} (blank: ${where}), Max boxes its most ${pods} at once, and GPU cap what they may cost together. Task folders kept per box applies when it runs on boxes.`}
        {p.docker &&
          " This project runs in a Docker container of its own: Tasks running at once sets its tasks in the container at once (blank: Settings › Docker › Tasks running at once per container), within the container's CPU and memory (Settings › Docker). Task folders kept per box applies when it runs on boxes."}
        {p.ssh &&
          " This project runs on your SSH machines: Tasks running at once limits its tasks on each machine, within the machine's own (Settings › Machines), and Whole machine keeps other projects' tasks off a machine while it runs. Task folders kept per box applies when it runs on boxes."}
      </p>
      <button type="button" onClick={() => openSettings("limits")} className="inline-flex min-h-11 items-center text-xs text-yard-400 hover:underline sm:min-h-0">
        Global: Settings › Boxes & limits
      </button>
      {/* An Upstash box size: other runners have their own (GPU machine below, Docker's and Daytona's settings, an SSH machine's own). A size already set stays, so it can be cleared. */}
      {(onBoxes || p.boxSize) && <OverrideField
        id="project-box-size"
        label="Box size"
        kind={auto ? "auto" : "global"}
        global={auto ? auto.field : `${s?.workerSize ?? "Settings"} (Worker size)`}
        set={Boolean(p.boxSize)}
        onClear={() => p.setBoxSize("")}
        hint={`${auto ? "Auto: Box Yard sizes its boxes from what its runs used, the smallest with RAM for 1.25 × the peak of the last 14 days, and a turn that runs out of memory carries on once on a bigger box. A size set here overrides that: n" : "N"}ew boxes made for this project are this size, and its tasks only run on boxes at least this big. Boxes it already has keep their size; resize them from the Boxes page.`}
      >
        <Select id="project-box-size" className="w-full min-w-0 sm:w-80" value={p.boxSize} onChange={(e) => p.setBoxSize(e.target.value as BoxSize | "")} data-testid="project-box-size">
          <option value="">{auto ? auto.option : `Global: ${worker}`}</option>
          {BOX_SIZES.map((size) => (
            <option key={size} value={size}>
              {BOX_SIZE_SPECS[size].label}: {sizeSpecLine(size)}
            </option>
          ))}
        </Select>
      </OverrideField>}
      <div className="grid gap-3 @4xl:grid-cols-3">
        <OverrideField
          id="project-agents-per-box"
          label="Tasks running at once (this project)"
          global={agents.long}
          set={p.agentsPerBox.trim() !== ""}
          onClear={() => p.setAgentsPerBox("")}
          hint="How many of this project's tasks can run at the same time on one box or this computer. Other projects' tasks never wait for it. 1: one at a time (game engines, big builds, headless browsers)."
          effect={agentsAtOnceLine(p.name, p.agentsPerBox, p.wholeMachine)}
        >
          <LimitInput id="project-agents-per-box" range={PROJECT_BOX_LIMITS.agentsPerBox} value={p.agentsPerBox} onChange={p.setAgentsPerBox} placeholder={`Global: ${agents.short}`} />
        </OverrideField>
        <OverrideField
          id="project-tasks-per-box"
          label="Task folders kept per box"
          global={folders.long}
          set={p.tasksPerBox.trim() !== ""}
          onClear={() => p.setTasksPerBox("")}
          hint="Most task folders on a box that holds one of this project's; older archived ones are parked to make room. Fewer suits a big repo."
        >
          <LimitInput id="project-tasks-per-box" range={PROJECT_BOX_LIMITS.tasksPerBox} value={p.tasksPerBox} onChange={p.setTasksPerBox} placeholder={`Global: ${folders.short}`} />
        </OverrideField>
        <OverrideField
          id="project-max-boxes"
          label="Max boxes"
          global={s ? `${s.maxBoxes} (the whole pool's Max boxes)` : "the pool's Max boxes"}
          set={p.maxBoxes.trim() !== ""}
          onClear={() => p.setMaxBoxes("")}
          hint="Most boxes this project's tasks use at once (made for it, or holding its task folders), within the pool's Max boxes. The rest wait for a free slot."
        >
          <LimitInput id="project-max-boxes" range={PROJECT_BOX_LIMITS.maxBoxes} value={p.maxBoxes} onChange={p.setMaxBoxes} placeholder={`Global: ${pool}`} />
        </OverrideField>
      </div>
      <label className="flex min-h-11 items-start gap-2 text-sm text-zinc-200 sm:min-h-0" htmlFor="project-whole-machine">
        <input id="project-whole-machine" type="checkbox" className="mt-0.5 shrink-0" checked={p.wholeMachine} onChange={(e) => p.setWholeMachine(e.target.checked)} data-testid="project-whole-machine" />
        <span className="min-w-0">
          Needs the whole machine
          <span className="block text-xs text-zinc-500">
            No other project's tasks run on the same box or this computer while one of its tasks runs, and its tasks wait for theirs to finish. For heavy benchmarks that need the machine to themselves. Off by default.
          </span>
        </span>
      </label>
      {p.gpu && (
        <OverrideField
          id="project-gpu-provider"
          label="GPU cloud"
          global={`${GPU_PROVIDER_LABEL[globalCloud]} (${GPU_DEFAULT_PATH})`}
          set={Boolean(m.provider)}
          onClear={() => setM({ provider: "", gpuTypes: null })}
          hint="Where its GPU pods come from. RunPod: pods with a network volume that keeps caches between runs. Vast.ai: a marketplace with more GPU types and stock, often cheaper, but no volume and hosts of varying reliability. Daytona: managed sandboxes, with a GPU or CPU only, deleted when idle (no volume); they count toward the daily cloud limit. Its tasks move once their workspace is archived."
        >
          <Select
            id="project-gpu-provider"
            className="w-full min-w-0 sm:w-80"
            value={m.provider}
            // Its own GPU types are one cloud's names: switching clouds goes back to the new cloud's list.
            onChange={(e) => setM({ provider: e.target.value as GpuProvider | "", gpuTypes: null })}
            data-testid="project-gpu-provider"
          >
            <option value="">Global: {GPU_PROVIDER_LABEL[globalCloud]}</option>
            {GPU_PROVIDERS.map((c) => (
              <option key={c} value={c}>
                {GPU_PROVIDER_LABEL[c]}
              </option>
            ))}
          </Select>
        </OverrideField>
      )}
      {p.gpu && (
        <OverrideField
          id="project-gpu-cap"
          label="GPU cap ($/hr)"
          global={gpuCap}
          set={p.gpuMaxHourlyUsd.trim() !== ""}
          onClear={() => p.setGpuMaxHourlyUsd("")}
          hint={`Most this project's ${GPU_PROVIDER_LABEL[provider]} ${pods} may cost together${onDaytona ? " (by Box Yard's estimate of Daytona's prices)" : ""}. A task that needs another over it waits and says so. 0: no cap of its own; ${where} › Max for all ${pods} still applies.`}
        >
          <LimitInput
            id="project-gpu-cap"
            range={PROJECT_BOX_LIMITS.gpuMaxHourlyUsd}
            step={0.05}
            value={p.gpuMaxHourlyUsd}
            onChange={p.setGpuMaxHourlyUsd}
            placeholder={g ? `Global: $${g.maxHourlyUsd}` : "Global"}
          />
        </OverrideField>
      )}
      {p.gpu && (
        <div className="space-y-3" data-testid="project-gpu-machine">
          <OverrideField
            id="project-gpu-types"
            label="GPU types"
            global={g ? `${g.gpuTypes.map(gpuLabel).join(", ")} (${where})` : `${where} › GPU types`}
            set={m.gpuTypes !== null}
            onClear={() => setM({ gpuTypes: null })}
            hint={
              onVast
                ? "Its new instances rent the cheapest offer of the first of these that has one within the caps. For browser and WebGL game testing an RTX 3070 or A4000 is plenty."
                : onDaytona
                  ? "Daytona gives its new sandboxes any free GPU of these types within the caps (priced at the dearest), or none: CPU only makes plain Linux sandboxes. For browser and WebGL game testing an RTX 4090 is plenty."
                  : "Its new pods try these in order; the first in stock within the caps wins. For browser and WebGL game testing an RTX A4000, RTX 4000 Ada or (Community) RTX 3070 is plenty."
            }
          >
            {m.gpuTypes ? (
              onVast ? (
                <VastGpuPicker id="project-gpu-types" value={m.gpuTypes} onChange={(gpuTypes) => setM({ gpuTypes })} enabled={Boolean(vast.data?.apiKey)} />
              ) : onDaytona ? (
                <DaytonaGpuPicker id="project-gpu-types" value={m.gpuTypes} onChange={(gpuTypes) => setM({ gpuTypes })} />
              ) : (
                <GpuTypePicker id="project-gpu-types" value={m.gpuTypes} onChange={(gpuTypes) => setM({ gpuTypes })} cloud={cloud} enabled={Boolean(runpod.data?.apiKey)} />
              )
            ) : (
              <Button type="button" size="sm" variant="ghost" onClick={() => setM({ gpuTypes: [...(g?.gpuTypes ?? [])] })} data-testid="project-gpu-types-own" disabled={!g}>
                Pick this project's own
              </Button>
            )}
          </OverrideField>
          {provider === "runpod" && <OverrideField id="project-gpu-cloud" label="Cloud" global={rp ? CLOUD_OPTION[rp.cloud].split(":")[0]! : "Settings › RunPod GPU › Cloud"} set={Boolean(m.cloud)} onClear={() => setM({ cloud: "" })} hint={CLOUD_HELP}>
            <Select id="project-gpu-cloud" className="w-full min-w-0 sm:w-80" value={m.cloud} onChange={(e) => setM({ cloud: e.target.value as RunPodCloud | "" })} data-testid="project-gpu-cloud">
              <option value="">Global: {rp ? CLOUD_OPTION[rp.cloud].split(":")[0] : "Settings › RunPod GPU"}</option>
              {RUNPOD_CLOUDS.map((c) => (
                <option key={c} value={c}>
                  {CLOUD_OPTION[c]}
                </option>
              ))}
            </Select>
          </OverrideField>}
          <div className="grid gap-3 @4xl:grid-cols-2">
            <OverrideField
              id="project-gpu-min-ram"
              label={onDaytona ? "Memory (GB)" : "Min RAM (GB)"}
              global={g ? `${g.minRamGb} GB (${where})` : `${where} › Min RAM`}
              set={m.minRamGb.trim() !== ""}
              onClear={() => setM({ minRamGb: "" })}
              hint={
                onDaytona
                  ? "Its new sandboxes get this much memory, billed per GB-hour. A game's browser needs about 12 GB."
                  : `Its new ${pods} only go to hosts with at least this much RAM. A game's browser needs about 12 GB; cheap ${onVast ? "marketplace" : "Community"} hosts can have less.`
              }
            >
              <LimitInput id="project-gpu-min-ram" range={RUNPOD_MACHINE_LIMITS.minRamGb} value={m.minRamGb} onChange={(minRamGb) => setM({ minRamGb })} placeholder={g ? `Global: ${g.minRamGb}` : "Global"} />
            </OverrideField>
            <OverrideField
              id="project-gpu-min-vcpus"
              label={onDaytona ? "vCPUs" : "Min vCPUs"}
              global={g ? `${g.minVcpus} (${where})` : `${where} › Min vCPUs`}
              set={m.minVcpus.trim() !== ""}
              onClear={() => setM({ minVcpus: "" })}
              hint={`…and ${onDaytona ? "this many vCPUs, billed per vCPU-hour" : "at least this many vCPUs"}. Running ${pods} keep what they have; these apply to new ones.`}
            >
              <LimitInput id="project-gpu-min-vcpus" range={RUNPOD_MACHINE_LIMITS.minVcpus} value={m.minVcpus} onChange={(minVcpus) => setM({ minVcpus })} placeholder={g ? `Global: ${g.minVcpus}` : "Global"} />
            </OverrideField>
          </div>
        </div>
      )}
    </div>
  )
}

/** A project setting with a global fallback: its label, the control, "Using global: …" (or the global it overrides) and Use global. */
function OverrideField({
  id,
  label,
  kind = "global",
  global,
  set,
  onClear,
  hint,
  effect,
  children,
}: {
  id: string
  label: string
  /** What applies when it's blank: the global setting, or Box Yard's own pick ("auto", the Box size). */
  kind?: "global" | "auto"
  global: string
  set: boolean
  onClear: () => void
  hint: string
  /** What the value does, as it stands (e.g. "keep-the-castle: 1 at a time; other projects unaffected."). */
  effect?: string
  children: ReactNode
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <label htmlFor={id} className="block text-xs font-medium tracking-wide whitespace-nowrap text-zinc-400 uppercase">
        {label}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        {children}
        {set && (
          <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={onClear} title={`Clear this project's ${label.toLowerCase()}: the ${kind} one applies`} data-testid={`${id}-clear`}>
            <X className="h-3.5 w-3.5" /> Use {kind}
          </Button>
        )}
      </div>
      <p className="text-xs text-zinc-500">
        <span className={set ? undefined : "text-zinc-300"} data-testid={`${id}-source`}>
          {set ? `Overrides ${kind}: ${global}.` : `Using ${kind}: ${global}.`}
        </span>{" "}
        {hint}
      </p>
      {effect && (
        <p className="text-xs text-zinc-300" data-testid={`${id}-effect`}>
          {effect}
        </p>
      )}
    </div>
  )
}

/** What Tasks running at once and Needs the whole machine do together, for the project's name: "keep-the-castle: 1 at a time; other projects unaffected." */
export function agentsAtOnceLine(name: string, agentsAtOnce: string, wholeMachine: boolean): string {
  const n = Number.parseInt(agentsAtOnce, 10)
  const own = Number.isFinite(n) && n > 0 ? `${n} at a time` : "up to the box's limit"
  return `${name || "This project"}: ${own}; ${wholeMachine ? "no other project's tasks run beside it." : "other projects unaffected."}`
}

function LimitInput({
  id,
  range,
  step,
  value,
  onChange,
  placeholder,
}: {
  id: string
  range: { min: number; max: number }
  /** Below 1 for a price; whole numbers otherwise. */
  step?: number
  value: string
  onChange: (v: string) => void
  placeholder: string
}) {
  return (
    <input
      id={id}
      type="number"
      inputMode={step && step < 1 ? "decimal" : "numeric"}
      min={range.min}
      max={range.max}
      step={step}
      className={cx(inputClass, "max-w-40! min-w-0")}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      data-testid={id}
    />
  )
}

/** Project › Settings › Runs on › Docker image as the form edits it: which source, and each one's text. */
type DockerDraft = { mode: "" | "image" | "dockerfile"; image: string; dockerfile: string }

const dockerDraft = (d: ProjectDocker): DockerDraft => ({ mode: d.dockerfile ? "dockerfile" : d.image ? "image" : "", image: d.image ?? "", dockerfile: d.dockerfile ?? "" })

/** What Save sends: only the source picked (the other is cleared). */
const dockerOf = (d: DockerDraft): ProjectDocker => ({
  image: d.mode === "image" ? d.image.trim() || null : null,
  dockerfile: d.mode === "dockerfile" ? d.dockerfile.trim() || null : null,
})

/**
 * A Docker project's image: Settings › Docker's, an image of its own, or its own Dockerfile built on Box Yard's
 * (BOXYARD_BASE), plus whether Docker can run now.
 */
function ProjectDockerSettings({ draft, setDraft }: { draft: DockerDraft; setDraft: (d: DockerDraft) => void }) {
  const status = useDocker()
  const openSettings = useOpenSettings()
  const global = status.data ? (status.data.settings.image ?? "Box Yard's own") : "Settings › Docker"
  const set = (patch: Partial<DockerDraft>) => setDraft({ ...draft, ...patch })
  return (
    <div className="space-y-2 sm:max-w-xl" data-testid="project-docker">
      <p className="text-xs text-zinc-500">
        Each task works in this project's own container on this computer: only its workspace volume is mounted (no folder of yours, no Docker socket), and the GitHub and Claude credentials from
        Settings › Credentials are put inside it, never in the image. Previews reach http://localhost.{" "}
        <button type="button" className="text-yard-400 underline-offset-2 hover:underline" onClick={() => openSettings("docker")}>
          Settings › Docker
        </button>
      </p>
      {status.data?.docker.error && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200" data-testid="project-docker-problem">
          {status.data.docker.error}. Its tasks wait until then.
        </p>
      )}
      <Field label="Docker image" hint="A Dockerfile builds on this computer on its first task (and again when it changes); FROM ${BOXYARD_BASE} starts from the image above it, with the agent tools.">
        <Select className="w-full sm:w-80" value={draft.mode} onChange={(e) => set({ mode: e.target.value as DockerDraft["mode"], ...(e.target.value === "dockerfile" && !draft.dockerfile.trim() ? { dockerfile: DOCKERFILE_TEMPLATE } : {}) })} data-testid="project-docker-mode">
          <option value="">Settings › Docker's ({global})</option>
          <option value="image">An image of its own</option>
          <option value="dockerfile">A Dockerfile of its own</option>
        </Select>
      </Field>
      {draft.mode === "image" && (
        <input
          className={cx(inputClass, "font-mono text-xs")}
          value={draft.image}
          onChange={(e) => set({ image: e.target.value })}
          placeholder="ghcr.io/you/agent:1 (needs bash, node, git and claude)"
          spellCheck={false}
          aria-label="Docker image"
          data-testid="project-docker-image"
        />
      )}
      {draft.mode === "dockerfile" && (
        <textarea
          className={cx(inputClass, "font-mono text-xs")}
          rows={8}
          value={draft.dockerfile}
          onChange={(e) => set({ dockerfile: e.target.value })}
          spellCheck={false}
          aria-label="Dockerfile"
          data-testid="project-dockerfile"
        />
      )}
    </div>
  )
}

/**
 * The project's colour (shared/projectColors.ts): its tasks' tiles and its chip in the Coordinator chat, its folder in
 * the sidebar. Auto is the one picked from its name, shown as it would be.
 */
export function ProjectColorPicker({ project, value, onChange }: { project: Project; value: ProjectColor | null; onChange: (c: ProjectColor | null) => void }) {
  const auto = useAutoColor(project)
  const swatch = (c: ProjectColor | undefined, on: boolean, label: string, pick: () => void, auto = false) => (
    <button
      key={label}
      type="button"
      role="radio"
      aria-checked={on}
      aria-label={label}
      title={label}
      onClick={pick}
      data-color={c}
      style={projectColorStyle(c)}
      className={cx(
        "flex h-7 items-center justify-center gap-1.5 rounded-lg pointer-coarse:h-11",
        auto ? "px-2 text-xs text-zinc-400 pointer-coarse:px-3" : "w-7 pointer-coarse:w-11",
        on ? "bg-zinc-800 text-zinc-100 ring-1 ring-zinc-600" : "hover:bg-zinc-800",
      )}
    >
      <span className="h-3 w-3 rounded-full bg-(--pc)" />
      {auto && "Auto"}
    </button>
  )
  return (
    <div className="space-y-1.5">
      <span id="project-color-label" className="block text-xs font-medium tracking-wide whitespace-nowrap text-zinc-400 uppercase">
        Colour
      </span>
      <div role="radiogroup" aria-labelledby="project-color-label" data-testid="project-color" className="flex flex-wrap gap-1">
        {swatch(auto, value === null, `Auto (${auto ?? "from its name"})`, () => onChange(null), true)}
        {PROJECT_COLORS.map((c) => swatch(c, value === c, c, () => onChange(c)))}
      </div>
      <span className="block text-xs text-zinc-500">Its tasks' icons and its chip in the Coordinator chat.</span>
    </div>
  )
}

/** The colour Auto gives `project`: the one picked from its name. */
function useAutoColor(project: Project) {
  const projects = useProjects().data
  return useMemo(() => projectColors((projects ?? [project]).map((p) => (p.id === project.id ? { ...p, color: null } : p))).get(project.id), [projects, project])
}

/** Settings › General › Icon, until Save: the icon it has, an image picked to replace it, or back to its letter. */
type IconDraft = { kind: "saved" } | { kind: "new"; file: File; url: string } | { kind: "removed" }

const ICON_MIME = /^image\/(?:png|jpeg|webp|gif|svg\+xml)$/
const ICON_EXT = /\.(?:png|jpe?g|webp|gif|svg)$/i
const iconMb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`

/** Why `file` can't be an icon, before it's sent: the server checks its bytes again on Save. */
function iconRefusal(file: File): string | null {
  if (!(file.type ? ICON_MIME.test(file.type) : ICON_EXT.test(file.name))) return `${file.name} isn't an image an icon can be: use a ${PROJECT_ICON_TYPES}.`
  if (!file.size) return `${file.name} is empty.`
  if (file.size > PROJECT_ICON_MAX_BYTES) return `${file.name} is ${iconMb(file.size)}; an icon can be up to ${iconMb(PROJECT_ICON_MAX_BYTES)}. Pick a smaller one.`
  return null
}

/**
 * The project's own icon (shared/projectIcons.ts), shown instead of its coloured letter wherever the app draws it. A
 * picked image shows here at once and is uploaded on Save; Remove goes back to the letter, in `color`.
 */
function ProjectIconPicker({
  project,
  name,
  color,
  draft,
  onChange,
  error,
  onError,
}: {
  project: Project
  /** The name and colour as edited, for the letter. */
  name: string
  color: ProjectColor | null
  draft: IconDraft
  onChange: (d: IconDraft) => void
  error: string | null
  onError: (message: string | null) => void
}) {
  const auto = useAutoColor(project)
  const input = useRef<HTMLInputElement>(null)
  const ids = useId()
  const src = draft.kind === "new" ? draft.url : draft.kind === "saved" ? project.iconUrl : null
  return (
    <div className="space-y-1.5">
      <span id={`${ids}-label`} className="block text-xs font-medium tracking-wide whitespace-nowrap text-zinc-400 uppercase">
        Icon
      </span>
      <div role="group" aria-labelledby={`${ids}-label`} aria-describedby={`${ids}-hint`} className="flex flex-wrap items-center gap-2" data-testid="project-icon-picker">
        <ProjectAvatar src={src} className="h-11 w-11 rounded-lg bg-zinc-800">
          <span
            aria-hidden
            data-testid="project-icon-letter"
            data-color={color ?? auto}
            style={projectColorStyle(color ?? auto)}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-(--pc)/15 text-lg font-semibold text-(--pc) uppercase"
          >
            {(name.trim() || project.name).slice(0, 1)}
          </span>
        </ProjectAvatar>
        <input
          ref={input}
          type="file"
          accept={PROJECT_ICON_ACCEPT}
          hidden
          tabIndex={-1}
          data-testid="project-icon-input"
          onChange={(e) => {
            const file = e.target.files?.[0]
            // Cleared, so picking the same file again still counts.
            e.target.value = ""
            if (!file) return
            const refusal = iconRefusal(file)
            onError(refusal)
            if (!refusal) onChange({ kind: "new", file, url: URL.createObjectURL(file) })
          }}
        />
        <Button type="button" size="sm" onClick={() => input.current?.click()} data-testid="project-icon-upload">
          <ImageUp className="h-3.5 w-3.5" />
          Upload image
        </Button>
        {src && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              onError(null)
              onChange(project.iconUrl ? { kind: "removed" } : { kind: "saved" })
            }}
            data-testid="project-icon-remove"
          >
            Remove
          </Button>
        )}
      </div>
      <span id={`${ids}-hint`} className="block text-xs text-zinc-500">
        {draft.kind === "removed" ? "Back to its coloured letter when you save. " : draft.kind === "new" ? "Applies when you save. " : ""}
        {PROJECT_ICON_TYPES}, up to {iconMb(PROJECT_ICON_MAX_BYTES)}, cropped to a square. It replaces the coloured letter wherever the project shows.
      </span>
      {error && (
        <p role="alert" className="text-xs text-red-300 wrap-anywhere" data-testid="project-icon-error">
          {error}
        </p>
      )}
    </div>
  )
}

/**
 * The project's Captain icon (shared/captainIcons.ts): one picked here, or Use default, which is the project's image if
 * it has one, else Settings › Coordinator › Captain icon. Under it, which one the Captain shows as the form stands, and
 * why. Places that show the project itself keep its image either way.
 */
function ProjectCaptainIconField({
  project,
  color,
  value,
  onChange,
  image,
  pending,
}: {
  project: Project
  color: ProjectColor | null
  value: CaptainIconId | null
  onChange: (id: CaptainIconId | null) => void
  /** The project's image as edited above, or null for none. */
  image: string | null
  /** This or the image differs from what's saved, so it applies on Save. */
  pending: boolean
}) {
  const auto = useAutoColor(project)
  const global = useCaptainIconSetting() ?? DEFAULT_CAPTAIN_ICON
  const openSettings = useOpenSettings()
  const ids = useId()
  const globalName = captainIconInfo(global)?.label ?? "Captain's cap"
  const shows = pending ? "Once you save, its Captain shows" : "Its Captain shows"
  const settings = (
    <button type="button" className="text-yard-400 underline-offset-2 hover:underline" onClick={() => openSettings("orchestrator")} data-testid="project-captain-icon-settings">
      Settings › Coordinator
    </button>
  )
  const fallback: CaptainIconDefault = image
    ? { preview: <ProjectAvatar src={image} className="h-6 w-6 rounded-md" />, label: "The project's image" }
    : { preview: <CaptainGlyph id={global} className="h-6 w-6" />, label: global === DEFAULT_CAPTAIN_ICON ? "The Captain's cap" : `${globalName}, from Settings` }
  const status = value ? (
    <>
      {shows} the {captainIconInfo(value)?.label ?? "icon"}: you picked it here{image ? ", so it shows instead of the project's image" : ""}.
    </>
  ) : image ? (
    <>{shows} the project's image: it uses the default, and a project's image comes before every Captain's icon in Settings. Pick an icon to show that instead.</>
  ) : (
    <>
      {shows} the {globalName}: it uses the default, every Captain's icon in {settings}.
    </>
  )
  return (
    <div className="space-y-1.5">
      <label htmlFor={`${ids}-toggle`} className="block text-xs font-medium tracking-wide whitespace-nowrap text-zinc-400 uppercase">
        Captain icon
      </label>
      <div className="sm:max-w-md">
        <CaptainIconPicker
          id={`${ids}-toggle`}
          value={value}
          onChange={onChange}
          color={color ?? auto ?? null}
          useDefault={fallback}
          status={status}
          testId="project-captain-icon"
        />
      </div>
    </div>
  )
}

/** Settings › Credentials' Claude login, as the browser may know it: which kind is set, never its value. */
function globalClaudeLogin(claude: SetupStatus["claude"] | undefined): string {
  if (!claude) return "Settings › Credentials’ Claude login"
  if (claude.using) return `Settings › Credentials’ ${CREDENTIAL_INFO[claude.using].label}`
  return claude.state === "set" ? "this computer’s own Claude Code login" : "none yet: add one in Settings › Credentials"
}

/**
 * The project's identity (docs/identities.md): who its agents and Captain act as, picked from the identities that
 * exist and saved with the form (PATCH /api/projects/:id `identityId`). Identities, and their Claude logins, are made
 * and changed in Settings › Identities; the Default identity's are Settings › Credentials. Names and kinds only, never a
 * token or key.
 */
function ProjectIdentityField({
  project,
  runner,
  saved,
  value,
  onChange,
  misfit,
  busy,
}: {
  project: Project
  runner: Runner
  /** The identity it had when the form opened. */
  saved: string
  value: string
  onChange: (id: string) => void
  /** Why the picked identity can't run on the form's runner ("runs only on this computer"). */
  misfit: string | null
  /** The title of the task whose running turn keeps the saved identity. */
  busy: string | null
}) {
  const identities = useIdentities()
  const setup = useSetup()
  const openSettings = useOpenSettings()
  const list = identities.data
  const picked = list?.find((i) => i.id === value)
  const current = list?.find((i) => i.id === saved)
  // A project that names a removed identity acts as Default (Identities.idOf), so it says so.
  const gone = Boolean(list) && !current
  const global = globalClaudeLogin(setup.data?.claude)
  const claude = !picked
    ? null
    : picked.isDefault
      ? global
      : !picked.claude
        ? `none of its own, so ${global}`
        : picked.claude.readable
          ? `its own ${picked.claude.kind === "api_key" ? "API key" : "OAuth token"}`
          : `its own can’t be read (this server’s secret key changed), so ${global} until it’s saved again`
  // A Claude login in the project's env vars beats the identity's for its agents (turnEnv); Captains don't read them.
  const envLogin = CLAUDE_CREDENTIAL_VARS.find((v) => project.envKeys.includes(v))
  const sharedWith = picked && !picked.isDefault ? picked.projectIds.filter((id) => id !== project.id).length : 0
  return (
    <section aria-labelledby="project-identity-heading" data-testid="project-identity-section" className="space-y-2.5 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h3 id="project-identity-heading" className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
          <KeyRound className="h-4 w-4 text-zinc-500" aria-hidden />
          Identity / Claude login
        </h3>
        <button type="button" className="text-xs text-yard-400 hover:underline" onClick={() => openSettings("identities")} data-testid="project-identity-manage">
          Settings › Identities
        </button>
      </div>
      <p className="text-xs text-zinc-500">Who this project’s agents and Captain act as: its GitHub account, commit author, signing key and Claude login.</p>
      <p className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-400" data-testid="identity-current">
        <span>Uses</span>
        {current ? (
          <IdentityBadge identity={current} />
        ) : (
          <span className="text-zinc-300">{list || saved === DEFAULT_IDENTITY_ID ? "Default" : identities.isError ? "an identity that couldn’t load" : "…"}</span>
        )}
        {(saved === DEFAULT_IDENTITY_ID || gone) && <span>{gone ? "(the identity it named was removed)" : "inherited from Settings › Credentials"}</span>}
        {value !== saved && picked && (
          <span className="flex items-center gap-1.5 text-amber-200" data-testid="identity-pending">
            → <IdentityBadge identity={picked} /> after Save
          </span>
        )}
      </p>
      <Field label="Identity">
        <Select className="w-full sm:w-80" disabled={!list} value={value} onChange={(e) => onChange(e.target.value)} data-testid="project-identity">
          {!picked && <option value={value}>{identities.isError ? "Couldn’t load identities" : !list ? "Loading identities…" : "Removed identity (acts as Default)"}</option>}
          {list?.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
              {i.githubLogin && i.githubLogin !== i.name ? ` · ${i.githubLogin}` : ""}
              {i.signing?.kind === "gpg" && runner !== "local" ? " (GPG: local runner only)" : i.runners && !i.runners.includes(runner) ? ` (not on ${RUNNER_LABEL[runner]})` : ""}
            </option>
          ))}
        </Select>
      </Field>
      {identities.isError && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-red-300">
          Couldn’t load identities: {identities.error.message}
          <Button type="button" size="sm" variant="ghost" onClick={() => void identities.refetch()}>
            Retry
          </Button>
        </div>
      )}
      {picked && (
        <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs" data-testid="identity-facts">
          <dt className="text-zinc-500">GitHub</dt>
          <dd className="min-w-0 wrap-anywhere text-zinc-300">
            {picked.githubLogin ?? (!picked.isDefault ? "no token yet" : setup.data?.github.state === "unset" ? "none yet: add a token in Settings › Credentials" : "Settings › Credentials’ token")}
          </dd>
          <dt className="text-zinc-500">Claude login</dt>
          <dd className="min-w-0 wrap-anywhere text-zinc-300" data-testid="identity-claude">
            {claude}
          </dd>
        </dl>
      )}
      {envLogin && (
        <p className="text-xs text-zinc-500" data-testid="identity-env-login">
          Its agents log in with this project’s {envLogin} env var instead; its Captain uses the login above.
        </p>
      )}
      {sharedWith > 0 && (
        <p className="text-xs text-zinc-500">
          {sharedWith} other project{sharedWith === 1 ? " uses" : "s use"} {picked!.name}: changing it in Settings › Identities changes theirs too.
        </p>
      )}
      {picked?.coordinatorSees === "status" && (
        <p className="text-xs text-zinc-500" data-testid="identity-status-only">
          The {picked.name} identity shows the Coordinator this project's status only (titles, states, PRs). Its Captain sees everything.
        </p>
      )}
      {misfit && picked && (
        <p role="note" className="text-xs text-amber-300" data-testid="identity-misfit">
          The {picked.name} identity {misfit}: pick another runner or identity.
        </p>
      )}
      {busy && (
        <p role="note" className="text-xs text-amber-300" data-testid="identity-busy">
          "{busy}" is running. Change the identity when it rests, so no turn switches accounts halfway.
        </p>
      )}
    </section>
  )
}

/** A project's settings tabs (SettingsTabs, as in Settings). Every field of the form is in exactly one. */
export type ProjectSection = "general" | "agents" | "boxes" | "git" | "notes" | "env"

export const PROJECT_SECTIONS: (SettingsTab<ProjectSection> & { description: string })[] = [
  { key: "general", label: "General", icon: FolderGit2, description: "Its name, repo and base branch, what it's for, and its colour and icon." },
  { key: "agents", label: "Agents & runners", icon: Bot, description: "Where its tasks run, the coding agent they run on, and who its agents and Captain act as." },
  { key: "boxes", label: "Boxes", icon: Boxes, description: "Its own box size and limits, and whether its tasks get node_modules from the box's dependency cache." },
  { key: "git", label: "Git & PRs", icon: GitPullRequest, description: "How its repo is mirrored and its work pushed, and what a merged pull request does." },
  { key: "notes", label: "Notes", icon: NotebookPen, description: "How much of this project's notes its agents' prompts carry." },
  { key: "env", label: "Env vars", icon: Variable, description: "Environment variables its agents get in every task." },
]

/** One tab's fields. Hidden tabs stay mounted, so switching tabs keeps every draft. */
function ProjectPanel({ section, open, children }: { section: ProjectSection; open: boolean; children: ReactNode }) {
  const info = PROJECT_SECTIONS.find((s) => s.key === section)!
  return (
    <div hidden={!open} data-project-section={section} className="@container">
      <PanelFrame title={info.label} description={info.description}>
        <div className="space-y-4">{children}</div>
      </PanelFrame>
    </div>
  )
}

export function ProjectSettings({ project, onDone, onDirtyChange }: { project: Project; onDone: () => void; onDirtyChange?: (dirty: boolean) => void }) {
  const update = useUpdateProject()
  const remove = useDeleteProject()
  const [, navigate] = useLocation()
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description)
  const [repo, setRepo] = useState(project.repo ?? "")
  const [baseBranch, setBaseBranch] = useState(project.baseBranch)
  const [env, setEnv] = useState("")
  const [removeKeys, setRemoveKeys] = useState<string[]>([])
  const [runner, setRunner] = useState<Runner>(project.runner ?? "box")
  const [machineLabel, setMachineLabel] = useState(project.machineLabel ?? "")
  // "" follows Settings › Box agents › Agent.
  const [agentCli, setAgentCli] = useState<AgentCli | "">(project.agentCli ?? "")
  const [boxSize, setBoxSize] = useState<BoxSize | "">(project.boxSize ?? "")
  const [partialClone, setPartialClone] = useState<"" | "on" | "off">(project.partialClone === null ? "" : project.partialClone ? "on" : "off")
  const [pushAtTurnEnd, setPushAtTurnEnd] = useState<"" | "on" | "off">(project.pushAtTurnEnd === null ? "" : project.pushAtTurnEnd ? "on" : "off")
  const [depCache, setDepCache] = useState<"" | "on" | "off">(project.depCache === null || project.depCache === undefined ? "" : project.depCache ? "on" : "off")
  const [autoDoneOnMerge, setAutoDoneOnMerge] = useState<"" | "on" | "off">(onOff(project.autoDoneOnMerge))
  const [closeIssuesOnMerge, setCloseIssuesOnMerge] = useState<"" | "on" | "off">(onOff(project.closeIssuesOnMerge))
  const [agentsPerBox, setAgentsPerBox] = useState(project.agentsPerBox?.toString() ?? "")
  const [wholeMachine, setWholeMachine] = useState(project.wholeMachine ?? false)
  const [tasksPerBox, setTasksPerBox] = useState(project.tasksPerBox?.toString() ?? "")
  const [maxBoxes, setMaxBoxes] = useState(project.maxBoxes?.toString() ?? "")
  const [gpuMaxHourlyUsd, setGpuMaxHourlyUsd] = useState(project.gpuMaxHourlyUsd?.toString() ?? "")
  const [machine, setMachine] = useState<MachineDraft>(() => machineDraft(project.gpuMachine, project.gpuProvider))
  const [docker, setDocker] = useState<DockerDraft>(() => dockerDraft(project.docker))
  const [notesMax, setNotesMax] = useState(project.notesMaxCount?.toString() ?? "")
  const [notesTokens, setNotesTokens] = useState(project.notesMaxTokens?.toString() ?? "")
  // What it was saved with when the form opened: Save's optimistic update changes `project` before the server answers.
  const [savedIdentityId] = useState(project.identityId || DEFAULT_IDENTITY_ID)
  const [identityId, setIdentityId] = useState(savedIdentityId)
  const identityChanged = identityId !== savedIdentityId
  const [color, setColor] = useState<ProjectColor | null>(project.color ?? null)
  const [captainIcon, setCaptainIcon] = useState<CaptainIconId | null>(project.captainIcon ?? null)
  const setIcon = useSetProjectIcon()
  const [icon, setIconDraft] = useState<IconDraft>({ kind: "saved" })
  const [iconError, setIconError] = useState<string | null>(null)
  // A picked image's preview lives until it's replaced or the form closes.
  useEffect(() => (icon.kind === "new" ? () => URL.revokeObjectURL(icon.url) : undefined), [icon])
  const saving = update.isPending || setIcon.isPending
  const identity = useIdentities().data?.find((i) => i.id === identityId)
  // Who it acts as can't change mid-turn: the server refuses, so the form says so first.
  const running = useRunningTask(project.id)
  const identityBusy = identityChanged && running
  const gpgMisfit = identity?.signing?.kind === "gpg" && runner !== "local"
  const identityMisfit = gpgMisfit || (identity?.runners && !identity.runners.includes(runner)) ? identity : null
  const settings = useAgentSettings()
  const server = useSettings()
  const setup = useSetup()
  // Without an Upstash key there's nowhere to make a box: "Upstash box" waits until one is added (unless it's already set).
  const noUpstash = setup.data?.upstash.available === false
  // GPU waits for a RunPod, Vast.ai or Daytona key (Settings › RunPod GPU, Settings › Vast.ai GPU, Settings › Daytona).
  const noRunPod =
    setup.data?.credentials.runpodApiKey?.state === "unset" && setup.data?.credentials.vastApiKey?.state !== "set" && setup.data?.credentials.daytonaApiKey?.state !== "set"
  const gpuCloud = effectiveGpuProvider(machine.provider || null, settings.data?.settings.gpuProvider ?? DEFAULT_GPU_PROVIDER)
  // SSH machine waits for a machine (Settings › Machines).
  const noMachines = useMachines().data?.machines.length === 0
  const openSettings = useOpenSettings()
  const defaults = settings.data?.settings
  const defaultAgentCli: AgentCli = defaults?.agentCli ?? DEFAULT_AGENT_CLI
  // What each tab edits. Save lights up once anything differs from what the form opened with, and goes dark again when
  // it's changed back; a tab with a change gets Settings' unsaved dot.
  const drafts: Record<ProjectSection, unknown[]> = {
    general: [name, description, repo, baseBranch, color, icon.kind === "new" ? icon.url : icon.kind, captainIcon],
    agents: [runner, runner === "ssh" ? machineLabel : "", docker, agentCli, identityId],
    boxes: [boxSize, agentsPerBox, wholeMachine, tasksPerBox, maxBoxes, gpuMaxHourlyUsd, machine, depCache],
    git: [partialClone, pushAtTurnEnd, autoDoneOnMerge, closeIssuesOnMerge],
    notes: [notesMax, notesTokens],
    env: [env, removeKeys],
  }
  const snapshot = Object.fromEntries(PROJECT_SECTIONS.map(({ key }) => [key, drafts[key].map((v) => JSON.stringify(v))])) as Record<ProjectSection, string[]>
  const [opened] = useState(snapshot)
  const changes = (key: ProjectSection) => snapshot[key].filter((v, i) => v !== opened[key][i]).length
  const changeCount = PROJECT_SECTIONS.reduce((n, { key }) => n + changes(key), 0)
  const dirty = changeCount > 0
  // Save waits while the identity can't be used: its tab gets Settings' needs-a-fix dot.
  const blocked = Boolean(identityMisfit) || Boolean(identityBusy) || (identityChanged && !identity)
  const [tab, setTab] = useState<ProjectSection>("general")
  const ids = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  // A field the browser refuses, found by Save in another tab: its tab opens first, then it's focused with the message.
  const [reveal, setReveal] = useState<HTMLInputElement | null>(null)
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange])
  useEffect(() => {
    panelRef.current?.scrollTo?.({ top: 0 })
  }, [tab])
  useEffect(() => {
    if (!reveal || reveal.closest("[hidden]")) return
    reveal.focus()
    reveal.reportValidity()
    setReveal(null)
  }, [reveal, tab])
  const cancel = async () => {
    if (dirty && !(await confirmDialog({ title: "Discard unsaved changes?", body: `Your edits to ${project.name}'s settings haven't been saved.`, confirmLabel: "Discard", cancelLabel: "Keep editing", danger: true })))
      return
    onDone()
  }

  return (
    // Save checks fields itself (noValidate): the browser's own check can't show a field in a hidden tab.
    <form
      className="settings-body @container flex min-h-0 flex-1 flex-col"
      aria-busy={saving}
      noValidate
      onSubmit={async (e) => {
        e.preventDefault()
        if (!dirty || saving || blocked) return
        const refused = [...e.currentTarget.elements].find((el): el is HTMLInputElement => el instanceof HTMLInputElement && el.willValidate && refusedByBrowser(el.validity))
        if (refused) {
          setTab((refused.closest<HTMLElement>("[data-project-section]")?.dataset.projectSection as ProjectSection | undefined) ?? tab)
          setReveal(refused)
          return
        }
        if (runner === "local" && project.runner !== "local") {
          const ok = await confirmDialog({
            title: "Run agents on this computer?",
            body: `${project.name}'s agents will run here, not in Upstash boxes. ${LOCAL_UNSANDBOXED} Its tasks move off their boxes when nothing would be lost.`,
            confirmLabel: "Run on this computer",
            danger: true,
          })
          if (!ok) return
        }
        if (runner === "ssh" && project.runner !== "ssh") {
          const ok = await confirmDialog({
            title: "Run agents on your SSH machines?",
            body: `${project.name}'s agents will run on your own computers over SSH, as the user Box Yard logs in as there, with that user's files and network: they're not sandboxed. Its tasks move over when nothing would be lost.`,
            confirmLabel: "Run on SSH machines",
            danger: true,
          })
          if (!ok) return
        }
        // The icon goes first: it's what the server is likeliest to refuse, and then nothing else has changed.
        if (icon.kind !== "saved") {
          try {
            await setIcon.mutateAsync({ id: project.id, file: icon.kind === "new" ? icon.file : null })
          } catch (err) {
            setIconError(`Couldn’t save the icon: ${(err as Error).message.replace(/\.$/, "")}.`)
            setTab("general")
            return
          }
          setIconDraft({ kind: "saved" })
          if (changeCount === 1) return onDone()
        }
        update.mutate({
          id: project.id,
          name,
          description,
          repo: repo.trim() || null,
          baseBranch,
          env: parseEnv(env),
          removeEnv: removeKeys,
          runner,
          ...(runner === "ssh" ? { machineLabel: machineLabel || null } : {}),
          boxSize: boxSize || null,
          partialClone: partialClone ? partialClone === "on" : null,
          pushAtTurnEnd: pushAtTurnEnd ? pushAtTurnEnd === "on" : null,
          depCache: depCache ? depCache === "on" : null,
          autoDoneOnMerge: autoDoneOnMerge ? autoDoneOnMerge === "on" : null,
          closeIssuesOnMerge: closeIssuesOnMerge ? closeIssuesOnMerge === "on" : null,
          agentsPerBox: optionalInt(agentsPerBox),
          wholeMachine,
          tasksPerBox: optionalInt(tasksPerBox),
          maxBoxes: optionalInt(maxBoxes),
          ...(runner === "gpu" || project.gpuMaxHourlyUsd !== null ? { gpuMaxHourlyUsd: optionalNumber(gpuMaxHourlyUsd) } : {}),
          ...(runner === "gpu"
            ? { gpuMachine: { gpuTypes: machine.gpuTypes, cloud: machine.cloud || null, minRamGb: optionalInt(machine.minRamGb), minVcpus: optionalInt(machine.minVcpus) }, gpuProvider: machine.provider || null }
            : {}),
          ...(runner === "docker" ? { docker: dockerOf(docker) } : {}),
          notesMaxCount: optionalInt(notesMax),
          notesMaxTokens: optionalInt(notesTokens),
          ...(identityChanged ? { identityId } : {}),
          ...(agentCli !== (project.agentCli ?? "") ? { agentCli: agentCli || null } : {}),
          ...(color !== (project.color ?? null) ? { color } : {}),
          ...(captainIcon !== (project.captainIcon ?? null) ? { captainIcon } : {}),
        }, { onSuccess: onDone })
      }}
    >
      {/* Locked while the save is on its way: the dialog closes only once the server has it. */}
      <fieldset disabled={saving} className="flex min-h-0 min-w-0 flex-1 flex-col">
        <SettingsTabs
          tabs={PROJECT_SECTIONS}
          selected={tab}
          onSelect={setTab}
          mark={(key) => (key === "agents" && blocked ? "problem" : changes(key) ? "unsaved" : null)}
          label="Project settings categories"
          selectLabel="Project settings category"
          idPrefix={ids}
          panelRef={panelRef}
          panelLabel={PROJECT_SECTIONS.find((s) => s.key === tab)!.label}
        >
          <ProjectPanel section="general" open={tab === "general"}>
            <Field label="Name">
              <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <div className="grid gap-3 @md:grid-cols-[minmax(0,1fr)_minmax(0,12rem)]">
              <Field label="Repo">
                <input className={inputClass} value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name" />
              </Field>
              <Field label="Branch">
                <input className={inputClass} value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} />
              </Field>
            </div>
            <Field label="Description">
              <textarea className={inputClass} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
            <ProjectColorPicker project={project} value={color} onChange={setColor} />
            <ProjectIconPicker project={project} name={name} color={color} draft={icon} onChange={setIconDraft} error={iconError} onError={setIconError} />
            <ProjectCaptainIconField
              project={project}
              color={color}
              value={captainIcon}
              onChange={setCaptainIcon}
              image={icon.kind === "new" ? icon.url : icon.kind === "saved" ? project.iconUrl : null}
              pending={icon.kind !== "saved" || captainIcon !== (project.captainIcon ?? null)}
            />
          </ProjectPanel>
          <ProjectPanel section="agents" open={tab === "agents"}>
            <div className="space-y-2">
              <Field
                label="Runs on"
                hint={`Upstash box: each agent runs in an isolated Upstash box. This computer: agents run straight on the computer running Box Yard (its GPU, its logged-in claude and gh), each task in its own folder in ${server.data?.localDir ?? "~/boxyard-workspaces"}, ${settings.data?.settings.localAgents ?? 2} at a time (Settings → Tasks running at once on this computer). RunPod GPU: the project gets GPU pods of its own at RunPod (up to its Max boxes, within its GPU cap), started when a task needs one and stopped when idle (Settings → RunPod GPU). Docker container: the project gets an isolated container of its own on this computer, started when a task needs it and stopped when idle (Settings → Docker). SSH machine: agents run on one of your own computers over SSH, a free one with the label you pick (Settings → Machines). Tasks move over when nothing would be lost.`}
              >
                <Select className="w-full sm:w-80" value={runner} onChange={(e) => setRunner(e.target.value as Runner)} data-testid="project-runner">
                  {RUNNERS.map((r) => (
                    <option
                      key={r}
                      value={r}
                      disabled={(r === "box" && noUpstash && project.runner === "local") || (r === "gpu" && noRunPod && project.runner !== "gpu") || (r === "ssh" && noMachines && project.runner !== "ssh")}
                    >
                      {RUNNER_LABEL[r]}
                      {r === "local"
                        ? " (not sandboxed)"
                        : r === "box" && noUpstash && project.runner === "local"
                          ? " (add an Upstash key in Settings first)"
                          : r === "gpu" && noRunPod && project.runner !== "gpu"
                            ? " (add a RunPod, Vast.ai or Daytona key in Settings first)"
                            : r === "ssh" && noMachines && project.runner !== "ssh"
                              ? " (add one in Settings › Machines first)"
                              : r === "ssh"
                                ? " (not sandboxed)"
                                : ""}
                    </option>
                  ))}
                </Select>
              </Field>
              {noUpstash && project.runner === "local" && (
                <p className="text-xs text-zinc-500" data-testid="runner-upstash-later">
                  To run this project in isolated Upstash boxes, add an Upstash Box API key in Settings › Box providers › Upstash boxes.
                </p>
              )}
              {(runner === "gpu" || noRunPod) && (
                <p className="text-xs text-zinc-500" data-testid="runner-gpu-note">
                  {runner !== "gpu"
                    ? "Need a GPU (a WebGL game, ML work)? Add a RunPod, Vast.ai or Daytona key to run this project on a GPU pod."
                    : gpuCloud === "daytona"
                      ? "Billed by Daytona per second while each sandbox runs, within the project's GPU cap, Settings › Daytona and the daily cloud limit. Sandboxes are deleted when idle and start fresh each time (no volume)."
                      : gpuCloud === "vast"
                        ? "Billed by Vast.ai per hour while each instance runs, within the project's GPU cap and Settings › Vast.ai GPU. Instances are destroyed when idle and start fresh each time (no volume)."
                        : "Billed by RunPod per hour while each pod runs, within the project's GPU cap and Settings › RunPod GPU. Pods stop when idle; pod #1's network volume keeps caches between its runs (more pods start from their own disk)."}{" "}
                  <button type="button" className="text-yard-400 underline-offset-2 hover:underline" onClick={() => openSettings(runner === "gpu" ? gpuCloud : "runpod")}>
                    {runner === "gpu" ? GPU_SETTINGS_PATH[gpuCloud] : "Settings › RunPod GPU"}
                  </button>
                </p>
              )}
              {runner === "local" && (
                <div role="note" className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200 sm:max-w-xl" data-testid="runner-warning">
                  <LineIcon icon={ShieldAlert} className="h-3.5 w-3.5 text-amber-300" />
                  <span>{LOCAL_UNSANDBOXED}</span>
                </div>
              )}
              {runner === "docker" && <ProjectDockerSettings draft={docker} setDraft={setDocker} />}
              {runner === "ssh" && (
                <Field label="Which machines" hint="A label (or one machine's name). Each task takes a free machine with it, and keeps its folder there between turns.">
                  <MachineLabelPicker value={machineLabel} onChange={setMachineLabel} />
                </Field>
              )}
              {(runner === "ssh" || noMachines) && (
                <p className="text-xs text-zinc-500" data-testid="runner-ssh-note">
                  {runner === "ssh" ? "Your own computers, reached over SSH from this one. Agents there aren't sandboxed." : "Old laptops or a GPU tower around? Add them as SSH machines and run projects on them."}{" "}
                  <button type="button" className="text-yard-400 underline-offset-2 hover:underline" onClick={() => openSettings("machines")}>
                    Settings › Machines
                  </button>
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Field label="Agent" hint="The coding agent its new tasks run on. Tasks it already has keep theirs.">
                <Select className="w-full sm:w-80" value={agentCli} onChange={(e) => setAgentCli(e.target.value as AgentCli | "")} data-testid="project-agent-cli">
                  <option value="">Settings default ({AGENT_CLI_LABEL[defaultAgentCli]})</option>
                  {AGENT_CLIS.map((c) => (
                    <option key={c} value={c}>
                      {AGENT_CLI_LABEL[c]}
                    </option>
                  ))}
                </Select>
              </Field>
              {(agentCli || defaultAgentCli) === "codex" && setup.data?.codex?.state === "unset" && (
                <p className="text-xs text-zinc-500" data-testid="project-codex-login">
                  Codex needs a login first.{" "}
                  <button type="button" className="text-yard-400 underline-offset-2 hover:underline" onClick={() => openSettings("credentials")}>
                    Settings › Credentials
                  </button>
                </p>
              )}
              {(agentCli || defaultAgentCli) === "cursor" && setup.data?.cursor?.state === "unset" && (
                <p className="text-xs text-zinc-500" data-testid="project-cursor-login">
                  Cursor needs a login first: a Cursor API key, or cursor-agent login on this computer.{" "}
                  <button type="button" className="text-yard-400 underline-offset-2 hover:underline" onClick={() => openSettings("credentials")}>
                    Settings › Credentials
                  </button>
                </p>
              )}
            </div>
            <ProjectIdentityField
              project={project}
              runner={runner}
              saved={savedIdentityId}
              value={identityId}
              onChange={setIdentityId}
              misfit={identityMisfit ? (gpgMisfit ? "uses this computer’s GPG keyring and requires the local runner" : `runs only on ${identityMisfit.runners!.map((r) => RUNNER_PHRASE[r]).join(" or ")}`) : null}
              busy={identityBusy ? identityBusy.title : null}
            />
          </ProjectPanel>
          <ProjectPanel section="boxes" open={tab === "boxes"}>
            <ProjectBoxSettings
              info={settings.data}
              projectId={project.id}
              name={name}
              local={runner === "local"}
              gpu={runner === "gpu"}
              docker={runner === "docker"}
              ssh={runner === "ssh"}
              boxSize={boxSize}
              setBoxSize={setBoxSize}
              agentsPerBox={agentsPerBox}
              setAgentsPerBox={setAgentsPerBox}
              wholeMachine={wholeMachine}
              setWholeMachine={setWholeMachine}
              tasksPerBox={tasksPerBox}
              setTasksPerBox={setTasksPerBox}
              maxBoxes={maxBoxes}
              setMaxBoxes={setMaxBoxes}
              gpuMaxHourlyUsd={gpuMaxHourlyUsd}
              setGpuMaxHourlyUsd={setGpuMaxHourlyUsd}
              machine={machine}
              setMachine={setMachine}
            />
            <Field
              label="Dependency cache"
              hint="On: a task with a package-lock.json and no node_modules (a fresh clone, or one the idle cleanup emptied) gets the box's installed copy for that lockfile, hard-linked in under a second, so it needs no npm ci. Off: agents install as usual."
            >
              <Select className="w-full sm:w-80" value={depCache} onChange={(e) => setDepCache(e.target.value as "" | "on" | "off")} data-testid="project-dep-cache">
                <option value="">Default ({settings.data?.settings.depCacheEnabled ? "on" : "off"}: Settings → Dependency cache)</option>
                <option value="on">On: restore node_modules from the box cache</option>
                <option value="off">Off: agents install dependencies</option>
              </Select>
            </Field>
          </ProjectPanel>
          <ProjectPanel section="git" open={tab === "git"}>
            <Field
              label="Partial clone mirror"
              hint="On: each box's mirror of the repo skips old file versions (blob:none) and fetches them from GitHub when git log -p, blame or a checkout needs them. Off: full mirror, for repos where agents dig through history a lot. Applies to mirrors made from now on; a mirror no task uses is re-made to match."
            >
              <Select className="w-full sm:w-80" value={partialClone} onChange={(e) => setPartialClone(e.target.value as "" | "on" | "off")} data-testid="project-partial-clone">
                <option value="">Default ({settings.data?.settings.gitPartialClone === false ? "off" : "on"}: Settings → Partial clone mirrors)</option>
                <option value="on">On: blob:none mirror</option>
                <option value="off">Off: full mirror</option>
              </Select>
            </Field>
            <Field
              label="Push at turn end"
              hint="On: after every turn Box Yard pushes the task's branch and keeps uncommitted work on a hidden ref (refs/boxyard/wip/<task>), so archives stay small and any box can go without losing code. Off: Box Yard pushes nothing itself, and archives hold the whole workspace. Needs write access to the repo; without it Box Yard falls back to full archives by itself."
            >
              <Select className="w-full sm:w-80" value={pushAtTurnEnd} onChange={(e) => setPushAtTurnEnd(e.target.value as "" | "on" | "off")} data-testid="project-push-at-turn-end">
                <option value="">Default ({settings.data?.settings.gitPushAtTurnEnd === false ? "off" : "on"}: Settings → Push at turn end)</option>
                <option value="on">On: push branch and WIP, small archives</option>
                <option value="off">Off: full archives</option>
              </Select>
            </Field>
            <Field
              label="Done when its PR merges"
              hint="On: when a task's pull request merges and its turn is over, it moves to done and its workspace is archived, as Mark done would. A task with queued messages or another open PR stays, and one set to stay open in its details (ⓘ) always does."
            >
              <Select className="w-full sm:w-80" value={autoDoneOnMerge} onChange={(e) => setAutoDoneOnMerge(e.target.value as "" | "on" | "off")} data-testid="project-auto-done-on-merge">
                <option value="">Default ({defaults?.autoDoneOnMerge === false ? "off" : "on"}: Settings → Done when its PR merges)</option>
                <option value="on">On: a merged PR moves its task to done</option>
                <option value="off">Off: you mark its tasks done yourself</option>
              </Select>
            </Field>
            <Field
              label="Close the issues it names"
              hint="On: when a task's pull request merges into a branch other than the repo's default (an epic branch), Box Yard closes the open issues of this repo it names with Fixes, Closes or Resolves #N, and comments with a link to the PR. GitHub already does this for the default branch."
            >
              <Select className="w-full sm:w-80" value={closeIssuesOnMerge} onChange={(e) => setCloseIssuesOnMerge(e.target.value as "" | "on" | "off")} data-testid="project-close-issues-on-merge">
                <option value="">Default ({defaults?.closeIssuesOnMerge === false ? "off" : "on"}: Settings → Close the issues it names)</option>
                <option value="on">On: close them after a merge into an epic branch</option>
                <option value="off">Off: leave issues to GitHub</option>
              </Select>
            </Field>
          </ProjectPanel>
          <ProjectPanel section="notes" open={tab === "notes"}>
            <div className="grid max-w-xl gap-3 @md:grid-cols-2">
              <Field label="Max notes" hint={`This project's own notes budget for agents' prompts. Blank: ${defaults?.notesMaxCount ?? DEFAULT_NOTE_BUDGET.maxNotes} (Settings → Max notes).`}>
                <input
                  type="number"
                  inputMode="numeric"
                  min={NOTE_BUDGET_LIMITS.maxNotes.min}
                  max={NOTE_BUDGET_LIMITS.maxNotes.max}
                  className={inputClass}
                  value={notesMax}
                  onChange={(e) => setNotesMax(e.target.value)}
                  placeholder={String(defaults?.notesMaxCount ?? DEFAULT_NOTE_BUDGET.maxNotes)}
                  data-testid="project-notes-max"
                />
              </Field>
              <Field label="Max note tokens" hint={`About how many tokens they may take. Blank: ${(defaults?.notesMaxTokens ?? DEFAULT_NOTE_BUDGET.maxTokens).toLocaleString()} (Settings).`}>
                <input
                  type="number"
                  inputMode="numeric"
                  min={NOTE_BUDGET_LIMITS.maxTokens.min}
                  max={NOTE_BUDGET_LIMITS.maxTokens.max}
                  step={100}
                  className={inputClass}
                  value={notesTokens}
                  onChange={(e) => setNotesTokens(e.target.value)}
                  placeholder={String(defaults?.notesMaxTokens ?? DEFAULT_NOTE_BUDGET.maxTokens)}
                  data-testid="project-notes-max-tokens"
                />
              </Field>
            </div>
          </ProjectPanel>
          <ProjectPanel section="env" open={tab === "env"}>
            <Field label="Env vars" hint="Values are write-only. Add KEY=value lines to set or replace.">
              <div className="mb-2 flex flex-wrap gap-1.5">
                {project.envKeys.map((k) => (
                  <button
                    type="button"
                    key={k}
                    onClick={() => setRemoveKeys((r) => (r.includes(k) ? r.filter((x) => x !== k) : [...r, k]))}
                    className={`min-h-11 rounded-md px-2 py-1 font-mono text-xs sm:min-h-0 sm:py-0.5 ${removeKeys.includes(k) ? "bg-red-500/20 text-red-300 line-through" : "bg-zinc-800 text-zinc-300"}`}
                    title="Click to remove"
                  >
                    {k}
                  </button>
                ))}
              </div>
              <textarea className={`${inputClass} font-mono text-xs`} rows={2} value={env} onChange={(e) => setEnv(e.target.value)} placeholder="NEW_KEY=value" />
            </Field>
          </ProjectPanel>
        </SettingsTabs>
        {/* One Save for every tab, as in Settings. */}
        <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-zinc-900 px-4 py-3 sm:px-5">
          <Button
            type="button"
            variant="danger"
            onClick={async () => {
              if (await confirmDialog({ title: "Delete project?", body: `Delete ${project.name} and all its tasks? This can't be undone.`, confirmLabel: "Delete project", danger: true })) {
                remove.mutate(project.id)
                navigate("/")
              }
            }}
          >
            <Trash2 className="h-4 w-4" /> Delete project
          </Button>
          <div className="flex flex-1 flex-wrap items-center justify-end gap-2 sm:gap-3">
            {update.isError ? (
              <p role="alert" className="basis-full text-right text-xs text-red-300 wrap-anywhere" data-testid="project-settings-error">
                Couldn’t save {project.name}’s settings: {update.error.message.replace(/\.$/, "")}. Your edits are still here, so you can try Save again.
              </p>
            ) : blocked && dirty ? (
              <span role="status" className="basis-full text-right text-xs text-red-300" data-testid="project-settings-problem">
                Fix 1 field to save
              </span>
            ) : dirty ? (
              <span role="status" className="basis-full text-right text-xs text-amber-300" data-testid="project-unsaved-count">
                {changeCount === 1 ? "1 unsaved change" : `${changeCount} unsaved changes`}
              </span>
            ) : null}
            <Button type="button" variant="ghost" onClick={() => void cancel()}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!dirty || saving || blocked} data-testid="project-settings-save">
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </footer>
      </fieldset>
    </form>
  )
}
