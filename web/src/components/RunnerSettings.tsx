// Settings › Box providers: where new projects run, then that provider's own sizes (Upstash boxes, Docker
// containers, Daytona sandboxes), the Default GPU cloud @gpu tasks use with its own GPUs, and a card per provider
// to drill into. Leaf IDs remain stable for links and draft ownership.
import { useState, type ReactNode } from "react"
import { Check, ChevronRight } from "lucide-react"
import { RUNNER_SECTIONS, type SettingsSection } from "../lib/settingsNav"
import { machinesSummary } from "../lib/machines"
import { useDaytona, useDocker, useMachines, useRunPod, useSetup, useVast } from "../lib/queries"
import { useSettingsSearching } from "../lib/settingsSearch"
import type { SetupStatus } from "../../../shared/setup"
import type { Settings } from "../../../shared/types"
import { DEFAULT_PROVIDERS, DEFAULT_PROVIDER_LABEL, type DefaultProvider } from "../../../shared/runner"
import { GPU_PROVIDERS, GPU_PROVIDER_LABEL, type GpuProvider } from "../../../shared/gpu"
import { DEFAULT_GPU_TYPES, gpuChoices, gpuTypesWords, sameGpu } from "../../../shared/gpuCatalog"
import { Panel, Row } from "./SettingsBlocks"
import { RunnerChoice, useRunnerDraft } from "./Setup"
import { DockerSizes } from "./DockerSettings"
import { DaytonaSizes } from "./DaytonaSettings"
import { UpstashSizes } from "./SizeCards"
import { Button, cx } from "./ui"
import { Loading } from "./Loading"

/** The dialog's own draft of plain Settings fields: the Upstash size and the Default GPU cloud edit it. */
export interface PlainSettings {
  s: Settings
  set: <K extends keyof Settings>(k: K, v: Settings[K]) => void
  hint: (k: keyof Settings) => ReactNode
}

const PROVIDER_SECTION: Record<DefaultProvider, SettingsSection> = { local: "local", box: "upstash", docker: "docker", daytona: "daytona", ssh: "machines" }

export function RunnerSettings({ fid, onSection, dirtySections, active, settings }: {
  fid: (k: string) => string
  onSection: (s: SettingsSection) => void
  dirtySections: Set<SettingsSection>
  active: boolean
  settings: PlainSettings | null
}) {
  const { data: s } = useSetup()
  const docker = useDocker({ enabled: active, poll: false })
  const machines = useMachines({ enabled: active })
  const searching = useSettingsSearching()
  const keyStatus = (key: "runpodApiKey" | "vastApiKey" | "daytonaApiKey") => s?.credentials[key]?.state === "set" ? "Key configured" : "API key missing"
  // null while it's still loading: the card shows the delayed skeleton line (components/Loading.tsx).
  const status = (section: SettingsSection): string | null => {
    if (!s) return null
    switch (section) {
      case "local": return localStatus(s)
      case "upstash": return s.upstash.available ? "Configured" : "API key missing"
      case "runpod": return keyStatus("runpodApiKey")
      case "vast": return keyStatus("vastApiKey")
      case "daytona": return keyStatus("daytonaApiKey")
      case "docker":
        if (!docker.data) return docker.error ? "Couldn't check Docker" : null
        if (!docker.data.docker.running) return "Docker not running"
        return docker.data.image.present ? "Ready" : "Docker running · image needed"
      case "machines":
        if (!machines.data) return machines.error ? "Couldn't load machines" : null
        return machinesSummary(machines.data.machines) ?? "No machines yet"
      default: return "Not checked"
    }
  }
  const saved = s && (s.runner.provider ?? s.runner.choice ?? "box")
  const defaultSection = saved ? PROVIDER_SECTION[saved] : null
  const gpuDefault = settings?.s.gpuProvider
  return <Panel section="runners">
    {!s ? <Loading count={1} label="Loading where agents run" /> : <Providers status={s} fid={fid} onSection={onSection} settings={settings} note={(p) => status(PROVIDER_SECTION[p]) ?? <Loading kind="line" label="Checking" />} />}
    {!settings ? <Loading count={1} label="Loading the Default GPU cloud" /> : <GpuCloudRow fid={fid} settings={settings} active={active} status={status} />}
    {!searching && <nav className="mt-6 space-y-2" aria-label="Runner providers">
      <h4 className="pb-1 text-xs font-semibold text-zinc-400">Each provider's settings</h4>
      {RUNNER_SECTIONS.map((sec, i) => <div key={sec.key}>
        {sec.group && sec.group !== RUNNER_SECTIONS[i - 1]?.group && <h4 className="pt-3 pb-2 text-xs font-semibold text-zinc-400">{sec.group}</h4>}
        <button type="button" data-runner-section={sec.key} onClick={() => onSection(sec.key)} className={`flex min-h-11 w-full items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yard-400 ${sec.group ? "pl-6" : ""}`}>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-zinc-100">
              {sec.label}
              {defaultSection === sec.key && <span className="rounded bg-yard-500/15 px-1.5 py-0.5 text-[11px] text-yard-300">Saved default</span>}
              {gpuDefault === sec.key && <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-300">Default GPU cloud</span>}
              {dirtySections.has(sec.key) && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" title="Unsaved changes" />}
            </span>
            <span className="mt-1 block text-xs text-zinc-400">{status(sec.key) ?? <Loading kind="line" label="Checking" />}</span>
          </span>
          <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-zinc-500" />
        </button>
      </div>)}
    </nav>}
  </Panel>
}

/** "New projects run on", then the size block of the provider picked there (kept mounted once shown, so its draft stays). */
function Providers({ status, fid, onSection, settings, note }: {
  status: SetupStatus
  fid: (k: string) => string
  onSection: (s: SettingsSection) => void
  settings: PlainSettings | null
  note: (p: DefaultProvider) => ReactNode
}) {
  const { current } = useRunnerDraft(status, "runners")
  const provider = current ?? "box"
  const [shown, setShown] = useState<DefaultProvider[]>([provider])
  if (!shown.includes(provider)) setShown([...shown, provider])
  return <>
    <Row id={fid("runner")} wide label="New projects run on" help="Pick a provider, then its size below. Existing projects keep their own Runs on choice (Project › Settings › Boxes). Save applies it.">
      <RunnerChoice status={status} compact section="runners" choices={DEFAULT_PROVIDERS} note={note} />
    </Row>
    {shown.map((p) => <div key={p} hidden={p !== provider} data-provider-size={p}>
      <ProviderSize provider={p} fid={fid} onSection={onSection} settings={settings} />
    </div>)}
  </>
}

function ProviderSize({ provider, fid, onSection, settings }: {
  provider: DefaultProvider
  fid: (k: string) => string
  onSection: (s: SettingsSection) => void
  settings: PlainSettings | null
}) {
  const section = PROVIDER_SECTION[provider]
  const more = <Button type="button" variant="subtle" className="mt-2 min-h-11 sm:min-h-0" onClick={() => onSection(section)}>All {DEFAULT_PROVIDER_LABEL[provider]} settings<ChevronRight aria-hidden="true" className="h-3.5 w-3.5" /></Button>
  switch (provider) {
    case "box":
      return <Row id={fid("ws-cards")} wide label="Upstash box size" help="The size new Upstash boxes get, unless a project sets its own Box size or auto-sizing picked one from its runs. Existing boxes keep theirs until resized on the Boxes page." hint={settings?.hint("workerSize")}>
        {settings ? <UpstashSizes value={settings.s.workerSize} onPick={(z) => settings.set("workerSize", z)} /> : <Loading kind="rows" count={1} label="Loading the Upstash size" />}
        {more}
      </Row>
    case "docker":
      return <Row id={fid("docker-size")} wide label="Docker container size" help="The CPUs and memory each Docker project's container may use. A running container takes a new size when it's next created.">
        <DockerSizes onCustom={() => onSection("docker")} />
        {more}
      </Row>
    case "daytona":
      return <Row id={fid("daytona-size")} wide label="Daytona sandbox size" help="What each Daytona project's sandbox gets: CPU only, or a GPU. Billed per second while it runs; prices are Daytona's list prices. A new size applies to sandboxes made after Save.">
        <DaytonaSizes onCustom={() => onSection("daytona")} />
        {more}
      </Row>
    case "local":
      return <Row id={fid("local-size")} label="Size" help="Tasks on this computer share its own CPU, memory and disk, so there's no size to pick. How many run at once is in Settings › Boxes & limits.">{more}</Row>
    case "ssh":
      return <Row id={fid("ssh-size")} label="Size" help="Each SSH machine runs tasks with its own CPU, memory and disk, so there's no size to pick. A project's label picks which machines it uses.">{more}</Row>
  }
}

/** The Default GPU cloud (Settings.gpuProvider, a plain field), then that cloud's GPUs with the "@" pick for each. */
function GpuCloudRow({ fid, settings, active, status }: { fid: (k: string) => string; settings: PlainSettings; active: boolean; status: (s: SettingsSection) => string | null }) {
  const cloud = settings.s.gpuProvider
  const runpod = useRunPod({ enabled: active && cloud === "runpod" })
  const vast = useVast({ enabled: active && cloud === "vast" })
  const daytona = useDaytona({ enabled: active && cloud === "daytona" })
  const configured = { runpod: runpod.data?.settings.gpuTypes, vast: vast.data?.settings.gpuTypes, daytona: daytona.data?.settings.gpuTypes }[cloud] ?? DEFAULT_GPU_TYPES[cloud]
  const gpus = gpuChoices(cloud, configured)
  return (
    <Row
      id={fid("gpu-cloud")}
      wide
      label="Default GPU cloud"
      help="Where @gpu tasks, and GPU projects without a cloud of their own, run. A project can pick its own cloud and GPU in Project › Settings › Boxes; a task can too, with @gpu:<cloud> or @gpu:<cloud>:<gpu> in a chat."
      hint={settings.hint("gpuProvider")}
    >
      <div role="radiogroup" aria-label="Default GPU cloud" className="@container grid gap-2 @lg:grid-cols-3">
        {GPU_PROVIDERS.map((p, i) => {
          const on = p === cloud
          return (
            <button
              key={p}
              id={i === 0 ? fid("gpu-cloud") : undefined}
              type="button"
              role="radio"
              aria-checked={on}
              data-gpu-cloud={p}
              onClick={() => settings.set("gpuProvider", p)}
              className={cx("flex min-h-11 flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition focus-visible:ring-2 focus-visible:ring-yard-400 focus-visible:outline-none", on ? "border-yard-500/60 bg-yard-500/10" : "border-zinc-800 bg-zinc-900 hover:border-zinc-700")}
            >
              <span className="flex w-full items-center gap-1.5 text-sm font-medium text-zinc-100">
                <span className="min-w-0 flex-1">{GPU_PROVIDER_LABEL[p]}</span>
                {on && <Check className="h-3.5 w-3.5 shrink-0 text-yard-300" aria-hidden="true" />}
              </span>
              <span className="text-[11px] text-zinc-500">{status(p) ?? "…"}</span>
            </button>
          )
        })}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-zinc-400" data-testid="gpu-default-line">
        <code className="font-mono text-zinc-300">@gpu</code> runs a task on {GPU_PROVIDER_LABEL[cloud]} with {gpuTypesWords(cloud, configured) || "its own GPU types"}, as {GPU_PROVIDER_LABEL[cloud]}'s settings ask.
      </p>
      <details className="mt-2 rounded-lg border border-zinc-900" data-testid="gpu-list">
        <summary className="flex min-h-11 cursor-pointer items-center px-3 text-xs font-medium text-zinc-300 select-none">
          {GPU_PROVIDER_LABEL[cloud]}'s {gpus.length} {cloud === "daytona" ? "choices" : "GPUs"}, and how to pick one in a chat
        </summary>
        <ul className="divide-y divide-zinc-900 border-t border-zinc-900">
          {gpus.map((g) => (
            <li key={g.slug} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2 text-xs" data-gpu={`${cloud}:${g.slug}`}>
              <span className="font-medium text-zinc-200">{g.label}</span>
              {configured.some((t) => sameGpu(t, g.id)) && <span className="rounded bg-zinc-800 px-1.5 py-px text-[10px] text-zinc-400">@gpu uses it</span>}
              <code className="font-mono text-yard-300">@gpu:{cloud}:{g.slug}</code>
              {g.hint && <span className="basis-full text-zinc-500">{g.hint}</span>}
            </li>
          ))}
        </ul>
      </details>
    </Row>
  )
}

function localStatus(s: SetupStatus) {
  if (!s.local) return "Tools not checked"
  return s.local.tools.some((t) => t.key === "node" && t.found) && s.local.tools.some((t) => (t.key === "claude" || t.key === "codex" || t.key === "cursor" || t.key === "opencode") && t.found) ? "Tools available" : "Tools need setup"
}
