import { useState } from "react"
import { useLocation } from "wouter"
import { projectChatHref } from "../lib/navigation"
import { ShieldAlert } from "lucide-react"
import { newClientId, useAgentSettings, useCreateProject, useMachines, useSetup } from "../lib/queries"
import { Modal } from "./Modal"
import { MachineLabelPicker } from "./MachineSettings"
import { SAVE_IDLE, StackedField } from "./SettingsBlocks"
import { Button, LineIcon, Select, inputClass, parseEnv } from "./ui"
import { LOCAL_UNSANDBOXED, RUNNERS, RUNNER_LABEL, type Runner } from "../../../shared/runner"
import { AGENT_CLIS, AGENT_CLI_LABEL, DEFAULT_AGENT_CLI, type AgentCli } from "../../../shared/agentCli"

/** `openChat` off leaves its opener in place (Settings › Projects, whose list shows the new project). */
export function NewProjectDialog({ onClose, openChat = true }: { onClose: () => void; openChat?: boolean }) {
  const [, navigate] = useLocation()
  const create = useCreateProject()
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [repo, setRepo] = useState("")
  const [baseBranch, setBaseBranch] = useState("main")
  const [env, setEnv] = useState("")
  const setup = useSetup()
  // Settings › Box providers' default until picked here: the server applies it (Daytona's GPU cloud included).
  const [picked, setPicked] = useState<Runner | null>(null)
  const runner = picked ?? setup.data?.runner.default ?? null
  const noUpstash = setup.data?.upstash.available === false
  // A GPU project runs on RunPod, Vast.ai or Daytona: any of their keys lets it be picked (Project › Settings › Boxes picks the cloud).
  const noRunPod =
    setup.data?.credentials.runpodApiKey?.state === "unset" && setup.data?.credentials.vastApiKey?.state !== "set" && setup.data?.credentials.daytonaApiKey?.state !== "set"
  const noMachines = useMachines().data?.machines.length === 0
  const [machineLabel, setMachineLabel] = useState("")
  // "" follows Settings › Box agents › Agent.
  const [agentCli, setAgentCli] = useState<AgentCli | "">("")
  const defaultAgentCli = useAgentSettings().data?.settings.agentCli ?? DEFAULT_AGENT_CLI

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    // Opened from Settings, it's inside Settings' own form in React's tree: the submit ends here, or Settings would save.
    e.stopPropagation()
    if (!name.trim()) return
    const id = newClientId("prj")
    create.mutate({ id, name: name.trim(), description, repo: repo.trim() || null, baseBranch, env: parseEnv(env), ...(picked && { runner: picked }), ...(runner === "ssh" ? { machineLabel: machineLabel || null } : {}), ...(agentCli && { agentCli }) })
    onClose()
    if (openChat) navigate(projectChatHref(id))
  }

  const dirty = Boolean(name || description || repo || env || baseBranch !== "main" || picked || machineLabel || agentCli)

  return (
    <Modal
      size="md"
      title="New project"
      dirty={dirty}
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim()} className={SAVE_IDLE}>
            Create project
          </Button>
        </>
      }
    >
      <StackedField label="Name">
        <input autoFocus className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="marketing-site" />
      </StackedField>
      <StackedField label="Description" hint="Agents in this project see this.">
        <textarea className={inputClass} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </StackedField>
      {/* Side by side by the dialog's own width, not the window's: at 125% zoom the two would share a sliver. */}
      <div className="@container">
        <div className="grid gap-4 @md:grid-cols-[minmax(0,1fr)_9rem] @md:gap-3">
          <StackedField label="GitHub repo (optional)" hint="owner/name. Leave empty for non-coding work.">
            <input className={inputClass} value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo" />
          </StackedField>
          <StackedField label="Base branch">
            <input className={inputClass} value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} />
          </StackedField>
        </div>
      </div>
      {runner && (
        <div className="space-y-2">
          <StackedField label="Runs on" hint="Change it any time in Settings › Projects.">
            <Select className="w-full" value={runner} onChange={(e) => setPicked(e.target.value as Runner)} data-testid="new-project-runner">
              {RUNNERS.map((r) => (
                <option key={r} value={r} disabled={(r === "box" && noUpstash) || (r === "gpu" && noRunPod) || (r === "ssh" && noMachines)}>
                  {RUNNER_LABEL[r]}
                  {r === "local"
                    ? " (not sandboxed)"
                    : r === "gpu"
                      ? noRunPod
                        ? " (add a RunPod, Vast.ai or Daytona key in Settings first)"
                        : ""
                      : r === "docker"
                        ? " (isolated, on this computer)"
                        : r === "ssh"
                          ? noMachines
                            ? " (add one in Settings › Machines first)"
                            : " (your own computers, not sandboxed)"
                          : noUpstash
                            ? " (add an Upstash key in Settings first)"
                            : ""}
                </option>
              ))}
            </Select>
          </StackedField>
          {runner === "local" && (
            <p role="note" className="flex items-start gap-2 text-xs leading-relaxed text-amber-200/90">
              <LineIcon icon={ShieldAlert} className="h-3.5 w-3.5 text-amber-300" />
              <span>{LOCAL_UNSANDBOXED}</span>
            </p>
          )}
          {runner === "ssh" && (
            <StackedField label="Which machines" hint="Agents run as the user Box Yard logs in as there: they're not sandboxed.">
              <MachineLabelPicker value={machineLabel} onChange={setMachineLabel} />
            </StackedField>
          )}
        </div>
      )}
      <StackedField label="Agent" hint="Claude Code, Codex, Cursor or OpenCode for its tasks. Change it any time in Settings › Projects.">
        <Select className="w-full" value={agentCli} onChange={(e) => setAgentCli(e.target.value as AgentCli | "")} data-testid="new-project-agent-cli">
          <option value="">Settings default ({AGENT_CLI_LABEL[defaultAgentCli]})</option>
          {AGENT_CLIS.map((c) => (
            <option key={c} value={c}>
              {AGENT_CLI_LABEL[c]}
            </option>
          ))}
        </Select>
      </StackedField>
      <StackedField label="Env vars (optional)" hint="KEY=value, one per line. Every task in the project gets them.">
        <textarea className={`${inputClass} font-mono text-xs`} rows={3} value={env} onChange={(e) => setEnv(e.target.value)} placeholder="DATABASE_URL=..." />
      </StackedField>
    </Modal>
  )
}
