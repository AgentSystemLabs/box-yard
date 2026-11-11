import { useState } from "react"
import { ArrowRightLeft } from "lucide-react"
import { AGENT_CLIS, AGENT_CLI_LABEL } from "../../../shared/agentCli"
import type { Task } from "../../../shared/types"
import type { TaskContinuation } from "../../../shared/taskContinuation"
import { useContinueTask } from "../lib/queries"
import { Modal } from "./Modal"
import { menuItem } from "./TaskHeader"
import { Button, Select } from "./ui"

/**
 * An explicit action: ordinary Retry and messages keep the task's saved harness. `menu`: a row of the details sheet's
 * actions, drawn like the rows beside it; elsewhere (a failed task's banner) it's a button.
 */
export function ContinueTask({ task, className, menu = false }: { task: Pick<Task, "id" | "agentCli" | "status">; className?: string; menu?: boolean }) {
  const [open, setOpen] = useState(false)
  const [agent, setAgent] = useState<NonNullable<TaskContinuation["agent"]>>(task.agentCli)
  const continuation = useContinueTask()
  if (!["failed", "idle", "pr_ready"].includes(task.status)) return null
  const reset = agent === "default" || agent !== task.agentCli
  const pick = () => { setAgent(task.agentCli); setOpen(true) }
  return <>
    {menu ? (
      <button type="button" className={menuItem} onClick={pick}>
        <ArrowRightLeft className="h-3.5 w-3.5 text-zinc-500" aria-hidden /> Continue with another agent…
      </button>
    ) : (
      <Button size="sm" variant="subtle" className={className} onClick={pick}>Continue with another agent…</Button>
    )}
    {open && <Modal
      title="Continue this task"
      size="sm"
      onClose={() => setOpen(false)}
      onSubmit={(event) => { event.preventDefault(); if (!continuation.isPending) continuation.mutate({ taskId: task.id, agent }, { onSuccess: () => setOpen(false) }) }}
      footer={<Button type="submit" loading={continuation.isPending}>Continue task</Button>}
    >
      <div className="space-y-4 p-5 text-sm">
        <p className="text-zinc-300">Keep this task, branch, workspace, attachments and conversation. Any queued messages go with it.</p>
        <label className="block space-y-1.5">
          <span className="font-medium">Harness</span>
          <Select className="w-full" value={agent} onChange={(e) => setAgent(e.target.value as typeof agent)}>
            {AGENT_CLIS.map((cli) => <option key={cli} value={cli}>{AGENT_CLI_LABEL[cli]}{cli === task.agentCli ? " (current)" : ""}</option>)}
            <option value="default">Current project / Settings default</option>
          </Select>
        </label>
        <p className="text-zinc-400">{reset ? "Clear this task's model, effort and routing pins and use the chosen harness's defaults and routing. A different harness starts a new CLI session with a recap of this task." : "Keep the saved model and effort choices and resume its current CLI session."}</p>
        <p className="text-xs text-zinc-500">This keeps its runner. Changing the default harness in Settings only affects new tasks; this choice applies to this task explicitly.</p>
      </div>
    </Modal>}
  </>
}
