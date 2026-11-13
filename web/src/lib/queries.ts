import { useCallback, useEffect, useMemo, useRef } from "react"
import { keepPreviousData, replaceEqualDeep, useMutation, useQuery, useQueryClient, type QueryClient, type QueryFunctionContext } from "@tanstack/react-query"
import { ApiError, api, clientId } from "./api"
import { afterPaint } from "./afterPaint"
import { toast } from "./toast"
import { closeInFlight, deferClose, undoClose, UNDO_MS } from "./inbox"
import { closeFailed, closeLanded, closeSent, closeUndone, keepClosed } from "./closedTasks"
import { STOP_GUARD_MS, keepStopped, staleAfterStop, stopExpired, stopFailed, stopSent, stoppedPatch } from "./stoppedTasks"
import { withCleanup } from "./diskCleanup"
import type { ProjectAutoSize } from "../../../shared/autoSize"
import type { UsageLedger } from "../../../shared/usageLedger"
import { withOwner } from "../../../shared/owner"
import { BUILTIN_MODELS, type ClaudeModel, type ModelCatalog } from "../../../shared/models"
import { DEFAULT_IDENTITY_ID, type Identity, type IdentityCheckResult, type IdentityDetection, type IdentityInput, type IdentitySigningInput, type IdentityClaudeKind } from "../../../shared/identities"
import type { CaptainIconId } from "../../../shared/captainIcons"
import type { Connector, ConnectorInput, ConnectorSignIn } from "../../../shared/connectors"
import type { TtsInfo } from "../../../shared/tts"
import type { UpdateStatus } from "../../../shared/selfUpdate"
import type { LimitsReport } from "../../../shared/loginLimits"
import type { CredentialKey, CredentialTest, CredentialsPatch, RecentRepos, SetupStatus } from "../../../shared/setup"
import type { AgentLogin, AgentLoginInput, LoginHarness } from "../../../shared/agentLogins"
import type { RunPodGpuOption, RunPodImageBuild, RunPodStatus } from "../../../shared/runpod"
import type { VastGpuOption, VastStatus } from "../../../shared/vast"
import type { DaytonaStatus } from "../../../shared/daytona"
import { buildProjectTargets, type InlinePick, type RunTarget, type RunTargetPick } from "../../../shared/runTargets"
import { GPU_POD_NOUN, gpuBoxProvider } from "../../../shared/gpu"
import type { DockerImageBuild, DockerStatus, ProjectDocker } from "../../../shared/docker"
import type { MachineSettings, MachineStatus, MachinesStatus } from "../../../shared/machines"
import type { DefaultProvider, Runner } from "../../../shared/runner"
import { AGENT_CLI_LABEL, DEFAULT_AGENT_CLI, canSteer, type AgentCli, type CursorModelList } from "../../../shared/agentCli"
import type { TaskContinuation } from "../../../shared/taskContinuation"
import type { ProjectColor } from "../../../shared/projectColors"
import { setTtsInfo } from "./tts"
import { settleOptimistic } from "./queued"
import { playSendSound } from "./sendSound"
import { prNumber } from "./prState"
import { fetchLiveState, fetchLog, liveMessage } from "./liveQueries"
import { reconcileTaskQueue, submissionId, taskMustWait, taskSubmissionWait } from "./taskSubmissions"
import type {
  BoxCleanup,
  BoxContents,
  BoxSize,
  AppNotification,
  Artifact,
  Attachment,
  BoxInfo,
  CloudStatus,
  CaptainCompaction,
  CaptainMessage,
  CaptainState,
  ChatMessage,
  CoordinatorEnvInfo,
  Effort,
  Health,
  OrchestratorState,
  Settings,
  SettingsInfo,
  Project,
  QueuedMessage,
  SteerDelivery,
  Schedule,
  ScheduleRun,
  ScheduleTarget,
  CatchUp,
  Task,
  TaskCompactionRecord,
  TaskMessage,
  TaskStatus,
  UsageReport,
  BudgetStatus,
} from "../../../shared/types"
import type { Hook, HookRun, HookTemplateView, HookWithLastRun } from "../../../shared/hooks"
import type { HookInput } from "./hookForm"

export const keys = {
  me: ["me"] as const,
  health: ["health"] as const,
  projects: ["projects"] as const,
  tasks: ["tasks"] as const,
  taskMessages: (id: string) => ["task-messages", id] as const,
  taskQueue: (id: string) => ["task-queue", id] as const,
  chat: ["chat"] as const,
  chatStream: ["chat-stream"] as const,
  chatBusy: ["chat-busy"] as const,
  artifacts: ["artifacts"] as const,
  boxes: ["boxes"] as const,
  /** Prefix of every box history query; a box.event invalidates them all. */
  schedules: ["schedules"] as const,
  scheduleRuns: ["schedule-runs"] as const,
  taskCompactions: (id: string) => ["task-compactions", id] as const,
  settings: ["settings"] as const,
  orchestrator: ["orchestrator"] as const,
  captain: (projectId: string) => ["captain", projectId] as const,
  captainMessages: (projectId: string) => ["captain-messages", projectId] as const,
  captainCompactions: (projectId: string) => ["captain-compactions", projectId] as const,
  agentSettings: ["agent-settings"] as const,
  models: ["models"] as const,
  tts: ["tts-settings"] as const,
  setup: ["setup"] as const,
  /** The Coordinator's own env vars' names (Settings › Coordinator › Env vars); the "coordinator.env" event keeps it live. */
  coordinatorEnv: ["coordinator-env"] as const,
  /** Settings › Credentials › More logins; the "logins" event keeps it live. */
  logins: ["logins"] as const,
  runpod: ["runpod"] as const,
  runpodGpus: ["runpod-gpus"] as const,
  vast: ["vast"] as const,
  vastGpus: ["vast-gpus"] as const,
  daytona: ["daytona"] as const,
  docker: ["docker"] as const,
  /** The Update button's state (GET /api/update); the "update" event keeps it live. */
  update: ["update"] as const,
  /** Cody's SSH machines (Settings › Machines, the Boxes page); the "machines" event keeps it live. */
  machines: ["machines"] as const,
  /** The chats' "@" list of where tasks run (GET /api/run-targets): the Coordinator's (null) or a Captain's. */
  runTargets: (projectId: string | null) => ["run-targets", projectId ?? ""] as const,
  /** The chats' "!" list of agent CLIs (GET /api/harness-targets), for where the message's tasks run. */
  harnessTargets: (projectId: string | null, runsOn: string | null) => ["harness-targets", projectId ?? "", runsOn ?? ""] as const,
  setupRepos: ["setup-repos"] as const,
  /** Cursor's models as its CLI lists them on the server (GET /api/cursor/models), for Settings › Box agents. */
  cursorModels: ["cursor-models"] as const,
  notifications: ["notifications"] as const,
  usage: ["usage"] as const,
  /** Each login's subscription limits (GET /api/limits); the "limits" event refetches it. */
  limits: ["limits"] as const,
  /** The cloud meter: today's box spend against the daily cloud limit, and the boxes (GET /api/cloud). */
  cloud: ["cloud"] as const,
  /** A project's hooks, or "global" for the Coordinator's. */
  hooks: (scope: string) => ["hooks", scope] as const,
  hookRuns: (scope: string) => ["hook-runs", scope] as const,
  hookTemplates: ["hook-templates"] as const,
  /** Mutation key of saving the project order, so live order events wait for the last save. */
  /** A project's note suggestions from agents: "pending", or "all" for the resolved ones too. */
  /** A project's snapshot and its running or last snapshot job. */
  identities: ["identities"] as const,
  /** External MCP connectors (Settings › Connectors); the "connectors" event keeps it live. */
  connectors: ["connectors"] as const,
  /** The box size auto-sizing picks for a project (shared/autoSize.ts). */
  projectAutoSize: (projectId: string) => ["project-auto-size", projectId] as const,
}

/** `?projectId=…` for a project's hooks, `?scope=global` for the Coordinator's. */
const hookQuery = (scope: string) => (scope === "global" ? "scope=global" : `projectId=${encodeURIComponent(scope)}`)

// ------------------------------------------------------------------ cache helpers

export function upsert<T extends { id: string }>(list: T[] | undefined, item: T, prepend = false): T[] {
  if (!list) return [item]
  const idx = list.findIndex((x) => x.id === item.id)
  if (idx === -1) return prepend ? [item, ...list] : [...list, item]
  const next = list.slice()
  next[idx] = item
  return next
}

export function patchTask(qc: QueryClient, id: string, patch: Partial<Task>) {
  qc.setQueryData<Task[]>(keys.tasks, (list) => list?.map((t) => (t.id === id ? { ...t, ...patch, updatedAt: Date.now() } : t)))
}

/** Run an optimistic change; returns a function that undoes it. */
function snapshot<T>(qc: QueryClient, key: readonly unknown[]) {
  const before = qc.getQueryData<T>(key)
  return () => qc.setQueryData(key, before)
}

// ------------------------------------------------------------------ queries

export const useMe = () => useQuery({ queryKey: keys.me, queryFn: () => api<{ authed: boolean; authRequired: boolean }>("/api/me") })
export const useHealth = () =>
  useQuery({ queryKey: keys.health, queryFn: () => api<Health>("/api/health"), refetchInterval: 30_000 })
/** Whether a newer Box Yard is out, and how its update is going (shared/selfUpdate.ts). The stream keeps it current. */
export const useUpdateStatus = () => useQuery({ queryKey: keys.update, queryFn: () => api<UpdateStatus>("/api/update"), staleTime: 60_000 })
/**
 * Look for a newer version, build it (Update), or restart into the built one now. The launcher's progress comes back on
 * the stream ("update" events), so the answer isn't written over it.
 */
export function useUpdateAction() {
  return useMutation({
    mutationFn: (action: "check" | "start" | "restart") => api<UpdateStatus>(`/api/update/${action}`, { method: "POST" }),
    onError: (err) => toast.error("Couldn't update Box Yard", (err as Error).message),
  })
}
/**
 * For views that read a list once, like the command palette: re-render when the list loads, not on every live update.
 * `data` is still current whenever the view renders for another reason (a keystroke).
 */
type Quiet = { notifyOnChangeProps?: ["status"] }
export const QUIET: Quiet = { notifyOnChangeProps: ["status"] }

export const useProjects = (o?: Quiet) => useQuery({ queryKey: keys.projects, queryFn: () => api<Project[]>("/api/projects"), notifyOnChangeProps: o?.notifyOnChangeProps })
/**
 * GET /api/tasks, with the tasks this browser just closed kept done against a fetch older than the close
 * (lib/closedTasks.ts), and the ones it stopped kept stopped while the fetch still has their turn (lib/stoppedTasks.ts).
 */
export const fetchTasks = ({ client }: QueryFunctionContext) =>
  api<Task[]>("/api/tasks").then((list) => {
    const cached = client.getQueryData<Task[]>(keys.tasks)
    return keepStopped(keepClosed(list, cached), cached)
  })
export const useTasks = (o?: Quiet) => useQuery({ queryKey: keys.tasks, queryFn: fetchTasks, notifyOnChangeProps: o?.notifyOnChangeProps })
/** The project's task whose turn is running (starting or working), as id and title. Re-renders only when that changes. */
export function useRunningTask(projectId: string) {
  const select = useCallback(
    (list: Task[]) => {
      const t = list.find((x) => x.projectId === projectId && (x.status === "starting" || x.status === "working"))
      return t ? { id: t.id, title: t.title } : null
    },
    [projectId],
  )
  return useQuery({ queryKey: keys.tasks, queryFn: fetchTasks, select }).data ?? null
}

/** Whether the project has any task, finished ones too; undefined until the list loads. Re-renders only when that flips. */
export function useHasTasks(projectId: string) {
  const select = useCallback((list: Task[]) => list.some((t) => t.projectId === projectId), [projectId])
  return useQuery({ queryKey: keys.tasks, queryFn: fetchTasks, select }).data
}

/** One task from the shared list. Re-renders only when that task changes, not on every task update. */
export function useTask(id: string) {
  const select = useCallback((list: Task[]) => list.find((t) => t.id === id) ?? null, [id])
  return useQuery({ queryKey: keys.tasks, queryFn: fetchTasks, select })
}
/**
 * A task's queued messages (the task page's Queued rows). Refetched when the task's queueRev changes, which only
 * this hook's component reads, so live task updates don't re-render the transcript.
 */
export function useTaskQueue(id: string) {
  const qc = useQueryClient()
  const select = useCallback((list: Task[]) => list.find((t) => t.id === id)?.queueRev ?? "", [id])
  const rev = useQuery({ queryKey: keys.tasks, queryFn: fetchTasks, select }).data ?? ""
  const queue = useQuery({ queryKey: keys.taskQueue(id), queryFn: async () => reconcileTaskQueue(qc, id, await api<QueuedMessage[]>(`/api/tasks/${id}/queue`)) })
  const seen = useRef<string | null>(null)
  useEffect(() => {
    // The first rev is what the first fetch already reflects.
    if (seen.current !== null && seen.current !== rev) void qc.invalidateQueries({ queryKey: keys.taskQueue(id) })
    seen.current = rev
  }, [qc, id, rev])
  return queue
}

/** Edit, cancel and undo a queued message. Optimistic; a 409 (already delivered) rolls back and refetches. */
export function useQueuedMessageActions(taskId: string) {
  const qc = useQueryClient()
  const key = keys.taskQueue(taskId)
  const patch = (fn: (list: QueuedMessage[]) => QueuedMessage[]) => {
    void qc.cancelQueries({ queryKey: key })
    const undo = snapshot<QueuedMessage[]>(qc, key)
    qc.setQueryData<QueuedMessage[]>(key, (list) => (list ? fn(list) : list))
    return { undo }
  }
  const settle = () => void qc.invalidateQueries({ queryKey: key })
  const edit = useMutation({
    mutationFn: (m: { id: string; text: string; version: number }) => api<QueuedMessage>(`/api/tasks/${taskId}/queue/${m.id}`, { method: "PATCH", body: { text: m.text, version: m.version } }),
    onMutate: (m) => patch((list) => list.map((x) => (x.id === m.id ? { ...x, text: m.text } : x))),
    onError: (err, _m, ctx) => {
      ctx?.undo()
      fail("Couldn't save the edit")(err)
    },
    onSettled: settle,
  })
  const remove = useMutation({
    mutationFn: (id: string) => api<QueuedMessage>(`/api/tasks/${taskId}/queue/${id}`, { method: "DELETE" }),
    onMutate: (id) => patch((list) => list.filter((x) => x.id !== id)),
    onError: (err, _id, ctx) => {
      ctx?.undo()
      fail("Couldn't cancel the message")(err)
    },
    onSettled: settle,
  })
  const restore = useMutation({
    mutationFn: (m: QueuedMessage) => api<QueuedMessage>(`/api/tasks/${taskId}/queue/${m.id}/restore`, { method: "POST" }),
    onMutate: (m) => patch((list) => [...list.filter((x) => x.id !== m.id), m].sort((a, b) => a.createdAt - b.createdAt)),
    onError: (err, _m, ctx) => {
      ctx?.undo()
      fail("Couldn't undo")(err)
    },
    onSettled: settle,
  })
  return { edit, remove, restore }
}

/**
 * What Steer on the task's Queued rows needs: whether a turn is running to steer into (not a /compact) and, for a
 * Cursor agent, which can't take a message mid-turn, its CLI's name (`noSteer`). A small select, so other
 * task updates don't re-render the queue.
 */
export function useSteerState(id: string) {
  const select = useCallback((list: Task[]) => {
    const t = list.find((x) => x.id === id)
    if (!t) return null
    return { running: t.status === "working" || t.status === "starting", compacting: t.compacting, noSteer: canSteer(t.agentCli) ? null : AGENT_CLI_LABEL[t.agentCli ?? DEFAULT_AGENT_CLI] }
  }, [id])
  return useQuery({ queryKey: keys.tasks, queryFn: fetchTasks, select }).data ?? null
}

/** Steer: every queued message goes into the task's running turn, in order; the agent reads them at its next step, without stopping. */
export function useSteerQueued(taskId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api<{ task: Task; delivery: SteerDelivery; queued: number; note?: string }>(`/api/tasks/${taskId}/queue/steer`, { method: "POST", body: {} }),
    onSuccess: ({ delivery, queued, note }) => {
      playSendSound()
      const them = queued === 1 ? "the queued message" : `all ${queued} queued messages`
      if (delivery === "steering") toast.info("Steering", `Delivery requested for ${them}; waiting for acknowledgment.`)
      else if (delivery === "after_turn") toast.info("Couldn't steer", `${note ? `${note[0]!.toUpperCase()}${note.slice(1)}` : "The running turn can't take it"}: ${them} go${queued === 1 ? "es" : ""} in when the turn ends.`)
      else if (delivery === "after_compaction") toast.info("Sending after compaction", `The agent is compacting its context; ${them} go out right after.`)
      else if (delivery === "already_delivered") toast.info("Already on their way", "A turn has taken the queued messages.")
      else toast.info("Sending", `No turn to steer: ${them} go out as the agent's next turn starts.`)
    },
    onError: (err) => {
      playSendSound("failed")
      fail("Couldn't steer")(err)
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: keys.taskQueue(taskId) }),
  })
}

/**
 * Edit or delete a message queued mid-turn in the Coordinator chat (`projectId` null) or a Captain's thread.
 * Optimistic; the live stream brings the server's copy. Delete shows an Undo toast. The server refuses once the
 * turn that reads it has started ("already delivered"), and the change rolls back.
 */
export function useQueuedChatActions(projectId: string | null) {
  const qc = useQueryClient()
  const key = projectId ? keys.captainMessages(projectId) : keys.chat
  const base = projectId ? `/api/projects/${projectId}/captain/messages` : "/api/chat/messages"
  type Msg = ChatMessage | CaptainMessage
  const patch = (id: string, fn: (m: Msg) => Msg) => {
    void qc.cancelQueries({ queryKey: key })
    const undo = snapshot<Msg[]>(qc, key)
    qc.setQueryData<Msg[]>(key, (list) => list?.map((m) => (m.id === id ? fn(m) : m)))
    return { undo }
  }
  const rollback = (title: string) => (err: Error, _v: unknown, ctx?: { undo: () => void }) => {
    ctx?.undo()
    void qc.invalidateQueries({ queryKey: key })
    fail(title)(err)
  }
  const restore = useMutation({
    mutationFn: (id: string) => api<Msg>(`${base}/${id}/restore`, { method: "POST" }),
    onMutate: (id) => patch(id, (m) => ({ ...m, meta: { ...withoutKey(m.meta, "cancelled"), queued: true } })),
    onError: rollback("Couldn't undo"),
  })
  const edit = useMutation({
    mutationFn: (m: { id: string; text: string }) => api<Msg>(`${base}/${m.id}`, { method: "PATCH", body: { text: m.text } }),
    onMutate: (m) => patch(m.id, (x) => ({ ...x, content: m.text.trim() })),
    onError: rollback("Couldn't save the edit"),
  })
  // Cancel. `untake`: the Undo of its text going back in the box (lib/takeBack.ts), for a failed cancel or Undo.
  const remove = useMutation({
    mutationFn: ({ id }: { id: string; untake?: (() => void) | null }) => api<Msg>(`${base}/${id}`, { method: "DELETE" }),
    onMutate: ({ id }) => patch(id, (m) => ({ ...m, meta: { ...withoutKey(m.meta, "queued"), cancelled: true } })),
    onError: (err, v, ctx) => {
      v.untake?.()
      rollback("Couldn't cancel the message")(err, v, ctx)
    },
    onSuccess: (_m, { id, untake }) =>
      toast.info("Message cancelled", untake ? "It's back in the message box." : undefined, {
        action: {
          label: "Undo",
          onClick: () => {
            untake?.()
            restore.mutate(id)
          },
        },
        duration: UNDO_MS,
      }),
  })
  return { edit, remove, restore }
}

function withoutKey(meta: Record<string, unknown> | null, key: string): Record<string, unknown> {
  const { [key]: _, ...rest } = meta ?? {}
  return rest
}

/** A task's transcript, its newest 1000 messages. Also loaded ahead of a click (lib/taskPrefetch.ts). */
export const fetchTaskMessages = (id: string, qc?: QueryClient) => fetchLog(keys.taskMessages(id), () => api<TaskMessage[]>(`/api/tasks/${id}/messages`), () => qc?.getQueryData(keys.taskMessages(id)))
export const useTaskMessages = (id: string) => useQuery({ queryKey: keys.taskMessages(id), queryFn: ({ client }) => fetchTaskMessages(id, client) })
export const useChat = () => useQuery({ queryKey: keys.chat, queryFn: ({ client }) => fetchLog(keys.chat, () => api<ChatMessage[]>("/api/chat"), () => client.getQueryData(keys.chat)) })
export const useArtifacts = (o?: Quiet) => useQuery({ queryKey: keys.artifacts, queryFn: () => api<Artifact[]>("/api/artifacts"), notifyOnChangeProps: o?.notifyOnChangeProps })
export const useSchedules = (o?: Quiet) => useQuery({ queryKey: keys.schedules, queryFn: () => api<Schedule[]>("/api/schedules"), notifyOnChangeProps: o?.notifyOnChangeProps })
export const useScheduleRuns = () => useQuery({ queryKey: keys.scheduleRuns, queryFn: () => api<ScheduleRun[]>("/api/schedule-runs") })
export const useTaskCompactions = (taskId: string) =>
  useQuery({ queryKey: keys.taskCompactions(taskId), queryFn: () => api<TaskCompactionRecord[]>(`/api/task-compactions?taskId=${encodeURIComponent(taskId)}`) })
export const useSettings = () =>
  useQuery({
    queryKey: keys.settings,
    queryFn: () => api<{ defaultTimezone: string; scheduler: "local" | "qstash"; maxUploadMb: number; localDir?: string }>("/api/settings"),
    staleTime: Infinity,
  })
export const useOrchestratorState = () =>
  useQuery({ queryKey: keys.orchestrator, queryFn: ({ client }) => fetchLiveState(client, keys.orchestrator, () => api<OrchestratorState>("/api/orchestrator")), staleTime: Infinity })
/** `enabled` false: no project yet (the Coordinator chat's bottom panel with "All" picked). */
export const useCaptainState = (projectId: string, o: { enabled?: boolean } = {}) =>
  useQuery({ queryKey: keys.captain(projectId), queryFn: ({ client }) => fetchLiveState(client, keys.captain(projectId), () => api<CaptainState>(`/api/projects/${projectId}/captain`)), staleTime: Infinity, enabled: o.enabled })
/** Captains whose cached messages are only the prefetched newest few (lib/captainPrefetch.ts), until the chat opens. */
const captainTails = new Set<string>()
export const markCaptainTail = (projectId: string) => void captainTails.add(projectId)
export const isCaptainTail = (projectId: string) => captainTails.has(projectId)
export const forgetCaptainTail = (projectId: string) => void captainTails.delete(projectId)

export const useCaptainMessages = (projectId: string, o: { enabled?: boolean } = {}) =>
  useQuery({
    queryKey: keys.captainMessages(projectId),
    queryFn: async ({ client, queryKey, signal }) => {
      // A refetch of what's on screen (a prefetched tail's whole history) goes once the chat it opens is painted.
      if (client.getQueryData(queryKey) !== undefined) await afterPaint()
      signal.throwIfAborted()
      const list = await fetchLog(keys.captainMessages(projectId), () => api<CaptainMessage[]>(`/api/projects/${projectId}/captain/messages`), () => client.getQueryData(keys.captainMessages(projectId)))
      forgetCaptainTail(projectId)
      return list
    },
    enabled: o.enabled,
    // A prefetched tail shows at once; the whole history loads in above it, quietly, as the chat opens.
    refetchOnMount: () => (captainTails.has(projectId) ? "always" : true),
    structuralSharing: shareById,
  })

/**
 * React Query's structural sharing for a list of messages, matched by id rather than position: older history loading
 * in above a prefetched tail keeps the messages already on screen as the same objects, so their memo'd rows stay put.
 */
export function shareById(prev: unknown, next: unknown): unknown {
  if (!Array.isArray(prev) || !Array.isArray(next)) return replaceEqualDeep(prev, next)
  const old = new Map<string, unknown>()
  for (const m of prev) if (m && typeof m.id === "string") old.set(m.id, m)
  let same = prev.length === next.length
  const out = next.map((m, i) => {
    const before = m && typeof m.id === "string" ? old.get(m.id) : undefined
    const kept = before === undefined ? m : replaceEqualDeep(before, m)
    if (kept !== prev[i]) same = false
    return kept
  })
  return same ? prev : out
}
/** Behind the Captain's ⋯ menu, so it loads once the chat that opened is painted. */
export const useCaptainCompactions = (projectId: string) =>
  useQuery({
    queryKey: keys.captainCompactions(projectId),
    queryFn: async ({ signal }) => {
      await afterPaint()
      signal.throwIfAborted()
      return api<CaptainCompaction[]>(`/api/projects/${projectId}/captain/compactions`)
    },
  })
export const useAgentSettings = (o: { enabled?: boolean } = {}) =>
  useQuery({ queryKey: keys.agentSettings, queryFn: () => api<SettingsInfo>("/api/agent-settings"), staleTime: Infinity, enabled: o.enabled })
/** Every model and effort picker's list: the installed CLI's own (GET /api/models), or the built-in one until then. */
export const useModelCatalog = (enabled = true) =>
  useQuery({ queryKey: keys.models, queryFn: () => api<ModelCatalog>("/api/models"), staleTime: 30 * 60_000, retry: false, enabled })
export const useModels = (): ClaudeModel[] => useModelCatalog().data?.models ?? (BUILTIN_MODELS as ClaudeModel[])
/** Settings › Voice text-to-speech choices; keys only as set/unset. Also feeds lib/speech's engine choice. */
export const useTtsSettings = () =>
  useQuery({
    queryKey: keys.tts,
    queryFn: async () => {
      const info = await api<TtsInfo>("/api/tts/settings")
      setTtsInfo(info)
      return info
    },
    staleTime: Infinity,
  })
export function useSaveTts() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: Record<string, unknown>) => api<TtsInfo>("/api/tts/settings", { method: "PUT", body: patch }),
    onSuccess: (info) => {
      qc.setQueryData(keys.tts, info)
      setTtsInfo(info)
    },
    onError: fail("Couldn't save the voice settings"),
  })
}
/** First-run setup and Settings › Credentials: what's set and where from, never a value. Kept live by the "setup" event. */
export const useSetup = (o: { enabled?: boolean } = {}) =>
  useQuery({ queryKey: keys.setup, queryFn: () => api<SetupStatus>("/api/setup"), staleTime: Infinity, enabled: o.enabled })
/** The GitHub token's most recently pushed repos, for TryFirst's prompts. Empty without a token or on any error. */
export const useRecentRepos = (o: { enabled?: boolean } = {}) =>
  useQuery({ queryKey: keys.setupRepos, queryFn: () => api<RecentRepos>("/api/setup/repos"), staleTime: Infinity, enabled: o.enabled })
/** The Claude and Codex logins new sessions rotate over (docs/logins.md): a label, last 4 and state, never a value. */
export const useLogins = () => useQuery({ queryKey: keys.logins, queryFn: () => api<AgentLogin[]>("/api/logins"), staleTime: Infinity })
/** The names of the Coordinator's own env vars, and which one is its Claude login. Values never come back. */
export const useCoordinatorEnv = () => useQuery({ queryKey: keys.coordinatorEnv, queryFn: () => api<CoordinatorEnvInfo>("/api/orchestrator/env"), staleTime: Infinity })
/** Set or replace some of the Coordinator's env vars and remove others; its next run reads them. */
export function useSaveCoordinatorEnv() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: { env?: Record<string, string>; removeEnv?: string[] }) => api<CoordinatorEnvInfo>("/api/orchestrator/env", { method: "PATCH", body: patch }),
    onSuccess: (info) => qc.setQueryData(keys.coordinatorEnv, info),
  })
}
/**
 * Add, rename or remove a login (Settings' Save runs them). The server's "logins" event updates the list too; these
 * apply the answer at once. Errors show in the dialog's "Couldn't save", so there's no toast.
 */
export function useLoginChanges() {
  const qc = useQueryClient()
  const put = (l: AgentLogin) => qc.setQueryData<AgentLogin[]>(keys.logins, (list) => (list ? (list.some((x) => x.id === l.id) ? list.map((x) => (x.id === l.id ? l : x)) : [...list, l]) : list))
  return {
    add: async (input: AgentLoginInput) => put(await api<AgentLogin>("/api/logins", { method: "POST", body: input })),
    rename: async (id: string, label: string) => put(await api<AgentLogin>(`/api/logins/${encodeURIComponent(id)}`, { method: "PATCH", body: { label } })),
    remove: async (id: string) => {
      await api(`/api/logins/${encodeURIComponent(id)}`, { method: "DELETE" })
      qc.setQueryData<AgentLogin[]>(keys.logins, (list) => list?.filter((x) => x.id !== id))
    },
  }
}
/** A login's Test: whether it answered, what it said (never a secret), and a saved login as it stands after it. */
type LoginTest = { ok: boolean; text: string; login?: AgentLogin }
/** Test a login: a saved one by id, or a value typed in before it's added. The answer never holds a secret. */
export function useTestLogin() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (o: { id: string } | { harness: LoginHarness; value: string }) =>
      "id" in o
        ? api<LoginTest>(`/api/logins/${encodeURIComponent(o.id)}/test`, { method: "POST" })
        : api<LoginTest>("/api/logins/test", { method: "POST", body: o }),
    onSuccess: ({ login }) => {
      if (login) qc.setQueryData<AgentLogin[]>(keys.logins, (list) => list?.map((x) => (x.id === login.id ? login : x)))
    },
  })
}
/** Save or remove credentials. Errors show next to the field, so there's no toast. */
export function useSaveCredentials() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: CredentialsPatch) => api<SetupStatus>("/api/setup/credentials", { method: "PUT", body: patch }),
    onSuccess: (status) => {
      qc.setQueryData(keys.setup, status)
      void qc.invalidateQueries({ queryKey: keys.health })
      void qc.invalidateQueries({ queryKey: keys.setupRepos })
    },
  })
}
/** The default provider for new projects (the setup choice, or Daytona or SSH machines): "local" needs no Upstash key. */
export function useSaveRunnerChoice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (runner: DefaultProvider) => api<SetupStatus>("/api/setup/runner", { method: "PUT", body: { runner } }),
    onSuccess: (status) => {
      qc.setQueryData(keys.setup, status)
      void qc.invalidateQueries({ queryKey: keys.health })
      void qc.invalidateQueries({ queryKey: keys.setupRepos })
    },
  })
}
/** Look at this computer's tools and logins again (Node, claude, gh, Chrome). */
export function useCheckLocal() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api<SetupStatus>("/api/setup/local/check", { method: "POST" }),
    onSuccess: (status) => {
      qc.setQueryData(keys.setup, status)
      void qc.invalidateQueries({ queryKey: keys.health })
    },
  })
}
/** A live check of a credential: `value` when given (typed, not saved), else the one in effect. */
export function useTestCredential() {
  return useMutation({
    mutationFn: ({ key, value }: { key: CredentialKey; value?: string }) =>
      api<CredentialTest>(`/api/setup/test/${key}`, { method: "POST", body: value ? { value } : {} }),
  })
}
/** What Box Yard calls its human (Settings › Box agents › Your name). */
export const useOwnerName = () => withOwner("Cody", useAgentSettings().data?.settings.ownerName)
/** Settings › Captain icon, every Captain's unless its project picks one (components/CaptainIcon.tsx); only it re-renders a Captain's icon. */
export const useCaptainIconSetting = () =>
  useQuery({ queryKey: keys.agentSettings, queryFn: () => api<SettingsInfo>("/api/agent-settings"), staleTime: Infinity, select: (s) => s.settings.captainIcon }).data
/** Newest first; kept live by the event stream (see lib/notifications.ts). */
export const useNotifications = () =>
  useQuery({ queryKey: keys.notifications, queryFn: () => api<AppNotification[]>("/api/notifications?limit=50"), staleTime: Infinity })
/** The usage report; with a range it includes `period` for it. Live events invalidate every range (prefix key). */
export const useUsage = (range?: { from: number; to: number; live: boolean }) =>
  useQuery({
    // A range that runs to "now" is keyed by its start only, so refetches don't make a new cache entry.
    queryKey: range ? [...keys.usage, range.from, range.live ? "now" : range.to] : keys.usage,
    queryFn: () => api<UsageReport>(range ? `/api/usage?from=${range.from}${range.live ? "" : `&to=${range.to}`}` : "/api/usage"),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  })

/** The cloud limits against box spend (the Usage modal's last card): the usage report's `budget` alone. */
export const useUsageBudget = () =>
  useQuery({ queryKey: [...keys.usage, "budget"], queryFn: () => api<BudgetStatus>("/api/usage/budget"), refetchInterval: 30_000, placeholderData: keepPreviousData })

/**
 * The Usage modal's ledger (shared/usageLedger.ts) for these local day starts, to now. Keyed under `usage`, so live
 * events refresh it with the rest; the minute poll keeps today's bar growing.
 */
export const useUsageLedger = (days: number[]) => useQuery({ ...usageLedgerQuery(days), refetchInterval: 60_000, placeholderData: keepPreviousData })

const usageLedgerQuery = (days: number[]) => ({
  queryKey: [...keys.usage, "daily", days[0], days.length],
  queryFn: () => api<UsageLedger>(`/api/usage/daily?days=${days.join(",")}`),
  // Fresh for a moment, so the modal that opens doesn't fetch again what pointing at its button just did.
  staleTime: 10_000,
})

/** Fetch a range's ledger before Usage opens: as a pointer comes to its button, or a finger presses it. */
export const prefetchUsageLedger = (qc: QueryClient, days: number[]) => qc.prefetchQuery(usageLedgerQuery(days))

/**
 * Each login's subscription limits, as its runs last reported them. The "limits" event refetches it when a reading
 * changes; the minute poll keeps "as of" and the windows that have reset since current.
 */
export const useLimits = (opts: { enabled?: boolean } = {}) =>
  useQuery({ queryKey: keys.limits, queryFn: () => api<LimitsReport>("/api/limits"), refetchInterval: 60_000, staleTime: 30_000, enabled: opts.enabled ?? true })

/**
 * The cloud meter. Polled, not refetched on every live box event: the server sums today's spend (cached 5 s), and
 * the meter moves in cents, so a 15-second refresh is live enough.
 */
export const useCloud = () =>
  useQuery({ queryKey: keys.cloud, queryFn: () => api<CloudStatus>("/api/cloud"), refetchInterval: 15_000, staleTime: 5_000 })

export const useChatStream = () =>
  useQuery({ queryKey: keys.chatStream, queryFn: () => "", initialData: "", staleTime: Infinity, gcTime: Infinity })
export const useChatBusy = () =>
  useQuery({
    queryKey: keys.chatBusy,
    queryFn: ({ client }) => fetchLiveState(client, keys.chatBusy, async () => (await api<Health>("/api/health")).orchestratorBusy),
    staleTime: Infinity,
  })

/** The health/SSE busy flag updates before the full Coordinator state during a turn's start/stop. */
export function useCoordinatorStatus() {
  const busy = useChatBusy().data
  const state = useOrchestratorState().data
  return { busy: busy ?? state?.busy ?? false, compacting: state?.compacting ?? false, error: state?.error ?? null }
}

// ------------------------------------------------------------------ mutations

const fail = (title: string) => (err: Error) => toast.error(title, err.message)

/** "Raise today's limit": a day's worth more cloud spend until midnight; boxes waiting on the limit start. */
export function useRaiseCloudLimit() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api<CloudStatus>("/api/cloud/raise", { method: "POST", body: {} }),
    onSuccess: (status) => {
      qc.setQueryData(keys.cloud, status)
      void qc.invalidateQueries({ queryKey: keys.usage })
    },
    onError: fail("Couldn't raise today's cloud limit"),
  })
}

/** "Allow more boxes": past the ones Box Yard makes in an hour without asking, for the next hour; tasks waiting on it start. */
export function useAllowMoreBoxes() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api<CloudStatus>("/api/cloud/allow-boxes", { method: "POST", body: {} }),
    onSuccess: (status) => qc.setQueryData(keys.cloud, status),
    onError: fail("Couldn't allow more boxes"),
  })
}

// ------------------------------------------------------------------ RunPod GPU (Settings › RunPod GPU)

/** Settings, pods, volumes, Docker and the image build. Polled while open: pods change at RunPod, not here. */
export const useRunPod = (o: { enabled?: boolean; poll?: boolean } = {}) =>
  useQuery({ queryKey: keys.runpod, queryFn: () => api<RunPodStatus>("/api/runpod"), enabled: o.enabled, refetchInterval: o.poll ? 15_000 : false, staleTime: 5_000 })
/** GPU types RunPod offers on Secure Cloud, cheapest first. */
export const useRunPodGpus = (o: { enabled?: boolean } = {}) =>
  useQuery({ queryKey: keys.runpodGpus, queryFn: () => api<RunPodGpuOption[]>("/api/runpod/gpus"), enabled: o.enabled, staleTime: 5 * 60_000 })
/** A RunPod action: save settings, build the image, keep a pod warm, delete a volume. */
export function useRunPodAction<T>(title: string, call: (input: T) => Promise<RunPodStatus | RunPodImageBuild>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: call,
    onSuccess: (r) => {
      if ("settings" in r) qc.setQueryData(keys.runpod, r)
      else void qc.invalidateQueries({ queryKey: keys.runpod })
    },
    onError: fail(title),
  })
}

// ------------------------------------------------------------------ Vast.ai GPU (Settings › Vast.ai GPU)

/** Settings, instances and the account's credit. Polled while open: instances change at Vast.ai, not here. */
export const useVast = (o: { enabled?: boolean; poll?: boolean } = {}) =>
  useQuery({ queryKey: keys.vast, queryFn: () => api<VastStatus>("/api/vast"), enabled: o.enabled, refetchInterval: o.poll ? 15_000 : false, staleTime: 5_000 })
/** GPU types with offers on Vast.ai's marketplace now (under the global filters), cheapest first. Each call is one search of Vast's daily quota, so it's kept a while. */
export const useVastGpus = (o: { enabled?: boolean } = {}) =>
  useQuery({ queryKey: keys.vastGpus, queryFn: () => api<VastGpuOption[]>("/api/vast/gpus"), enabled: o.enabled, staleTime: 5 * 60_000, retry: false })
/** A Vast.ai action: save settings, keep an instance warm. */
export function useVastAction<T>(title: string, call: (input: T) => Promise<VastStatus>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: call,
    onSuccess: (r) => qc.setQueryData(keys.vast, r),
    onError: fail(title),
  })
}

// ------------------------------------------------------------------ Daytona (Settings › Daytona)

/** Settings and sandboxes. Polled while open: sandboxes change at Daytona, not here. */
export const useDaytona = (o: { enabled?: boolean; poll?: boolean } = {}) =>
  useQuery({ queryKey: keys.daytona, queryFn: () => api<DaytonaStatus>("/api/daytona"), enabled: o.enabled, refetchInterval: o.poll ? 15_000 : false, staleTime: 5_000 })
/** A Daytona action: save settings, keep a sandbox warm. */
export function useDaytonaAction<T>(title: string, call: (input: T) => Promise<DaytonaStatus>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: call,
    onSuccess: (r) => qc.setQueryData(keys.daytona, r),
    onError: fail(title),
  })
}

// ------------------------------------------------------------------ Docker (Settings › Docker)

/** Docker on this computer, the settings, the image and its build, and Box Yard's containers. Polled while open: containers change in Docker, not here. */
export const useDocker = (o: { enabled?: boolean; poll?: boolean } = {}) =>
  useQuery({ queryKey: keys.docker, queryFn: () => api<DockerStatus>("/api/docker"), enabled: o.enabled, refetchInterval: o.poll ? 10_000 : false, staleTime: 5_000 })
/** A Docker action: save settings, build the image, stop a container. */
export function useDockerAction<T>(title: string, call: (input: T) => Promise<DockerStatus | DockerImageBuild>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: call,
    onSuccess: (r) => {
      if ("settings" in r) qc.setQueryData(keys.docker, r)
      else void qc.invalidateQueries({ queryKey: keys.docker })
    },
    onError: fail(title),
  })
}

// ------------------------------------------------------------------ SSH machines (Settings › Machines)

/** Every SSH machine with its state, labels and last test. The "machines" event keeps it live. */
export const useMachines = (o?: Quiet & { enabled?: boolean }) =>
  useQuery({ queryKey: keys.machines, queryFn: () => api<MachinesStatus>("/api/machines"), enabled: o?.enabled, notifyOnChangeProps: o?.notifyOnChangeProps, staleTime: 5_000 })

/**
 * Shared by mounted composers and their open/focus refresh. fetchQuery deduplicates in-flight/fresh requests. The list
 * loads once the chat its composer opened with is painted.
 */
const runTargetsQuery = (projectId: string | null) => ({
  queryKey: keys.runTargets(projectId),
  queryFn: async ({ signal }: QueryFunctionContext) => {
    await afterPaint()
    signal.throwIfAborted()
    return api<RunTarget[]>(`/api/run-targets${projectId ? `?project=${encodeURIComponent(projectId)}` : ""}`)
  },
  staleTime: 30_000,
  refetchOnWindowFocus: true,
  retry: false,
})

type PickerActivity = "menu" | "focus" | "mention" | null

/** Prefetch on composer mount; render cached options throughout a refresh, without polling availability checks. */
export function useRunTargets(projectId: string | null, enabled = true, activity: PickerActivity = null) {
  const qc = useQueryClient()
  useEffect(() => {
    if (enabled && activity) void qc.fetchQuery(runTargetsQuery(projectId)).catch(() => {})
  }, [qc, projectId, enabled, activity])
  return useQuery({ ...runTargetsQuery(projectId), enabled })
}

const harnessTargetsQuery = (projectId: string | null, runsOn: string | null) => ({
  queryKey: keys.harnessTargets(projectId, runsOn),
  queryFn: async ({ signal }: QueryFunctionContext) => {
    await afterPaint()
    // Reading the signal before the wait lets React Query cancel when the last observer leaves.
    signal.throwIfAborted()
    const q = new URLSearchParams({ ...(projectId ? { project: projectId } : {}), ...(runsOn ? { runsOn } : {}) }).toString()
    return api<RunTarget[]>(`/api/harness-targets${q ? `?${q}` : ""}`)
  },
  staleTime: 30_000,
  refetchOnWindowFocus: true,
  retry: false,
})

/**
 * Cursor's models (server/cursor.ts CursorModels): read from `cursor-agent models` on the server and cached there,
 * else the last list it saved, else a dated snapshot; `source` says which. Only fetched where a picker shows it.
 */
export function useCursorModels(enabled = true) {
  return useQuery({ queryKey: keys.cursorModels, queryFn: () => api<CursorModelList>("/api/cursor/models"), enabled, staleTime: 10 * 60_000, retry: false })
}

/** Ask the server's CLI for Cursor's list again now (Settings' Refresh). */
export function useRefreshCursorModels() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api<CursorModelList>("/api/cursor/models?refresh=1"),
    onSuccess: (list) => qc.setQueryData(keys.cursorModels, list),
  })
}

/**
 * The "!" list of agent CLIs for a message whose tasks go where `runsOn` says (its "@" pick; null: the project's Runs
 * on, or the default): each that's installed and signed in there (shared/runTargets.ts). Switching the "@" pick keeps
 * the last list on screen until the new one is in; the picker marks that previous location's options as checking.
 */
export function useHarnessTargets(projectId: string | null, runsOn: string | null, enabled = true, activity: PickerActivity = null) {
  const qc = useQueryClient()
  useEffect(() => {
    if (enabled && activity) void qc.fetchQuery(harnessTargetsQuery(projectId, runsOn)).catch(() => {})
  }, [qc, projectId, runsOn, enabled, activity])
  return useQuery({ ...harnessTargetsQuery(projectId, runsOn), enabled, placeholderData: keepPreviousData })
}

/**
 * For a press that opens a picker's list (the Where or Harness button): a stale or failed list refreshes in the
 * background, as opening its menu used to, while the cached rows stay on screen. A fresh one isn't asked again.
 */
export function useRefreshPicker(projectId: string | null) {
  const qc = useQueryClient()
  return useCallback(
    (kind: "runsOn" | "agent", runsOn: string | null) => {
      const done = () => {}
      if (kind === "runsOn") void qc.fetchQuery(runTargetsQuery(projectId)).catch(done)
      else void qc.fetchQuery(harnessTargetsQuery(projectId, runsOn)).catch(done)
    },
    [qc, projectId],
  )
}

/**
 * The Coordinator chat's "%" list: Cody's projects as pick targets (shared/runTargets.ts buildProjectTargets). Re-renders
 * only when a project's name, repo or order changes, not on its other settings.
 */
export function useProjectTargets(enabled: boolean): RunTarget[] | undefined {
  return useQuery({ queryKey: keys.projects, queryFn: () => api<Project[]>("/api/projects"), select: buildProjectTargets, enabled }).data
}

/** What Default means in a project's Captain chat: its name, Runs on and agent. Null for the Coordinator's or while loading. */
export interface ProjectRunDefaults {
  name: string
  runner: Runner
  machineLabel: string | null
  /** Its Agent, else Settings › Box agents. */
  agentCli: AgentCli
}

/** The composer's Default picks for `projectId`'s Captain chat. Re-renders only when its name, Runs on or agent changes. */
export function useProjectRunDefaults(projectId: string | null): ProjectRunDefaults | null {
  const pickProject = useCallback(
    (list: Project[]) => {
      const p = list.find((x) => x.id === projectId)
      return p ? { name: p.name, runner: p.runner, machineLabel: p.machineLabel, agentCli: p.agentCli } : null
    },
    [projectId],
  )
  const project = useQuery({ queryKey: keys.projects, queryFn: () => api<Project[]>("/api/projects"), select: pickProject, enabled: projectId !== null }).data
  const settingsCli = useQuery({ queryKey: keys.agentSettings, queryFn: () => api<SettingsInfo>("/api/agent-settings"), staleTime: Infinity, select: selectAgentCli, enabled: projectId !== null }).data
  return useMemo(
    () => (projectId && project ? { ...project, agentCli: project.agentCli ?? settingsCli ?? DEFAULT_AGENT_CLI } : null),
    [projectId, project, settingsCli],
  )
}
const selectAgentCli = (s: SettingsInfo) => s.settings.agentCli

/** What Add and Edit send. The key is a reference (file:~/.ssh/<key>, agent, …), never a key. */
export interface MachineForm {
  name: string
  host: string
  user: string
  port?: number
  keyRef: string
  maxTasks?: number
  labels?: string[]
  dir?: string
  enabled?: boolean
}

type MachineReply = { machine: MachineStatus; status: MachinesStatus }

/** The calls Settings › Machines makes; each answers with every machine's status. */
export const machineApi = {
  add: (input: MachineForm & { test?: boolean }) => api<MachineReply>("/api/machines", { body: input }),
  update: (id: string, patch: Partial<MachineForm>) => api<MachineReply>(`/api/machines/${encodeURIComponent(id)}`, { method: "PATCH", body: patch }),
  test: (id: string) => api<MachineReply>(`/api/machines/${encodeURIComponent(id)}/test`, { method: "POST" }),
  forgetHostKey: (id: string) => api<MachineReply>(`/api/machines/${encodeURIComponent(id)}/forget-host-key`, { method: "POST" }),
  remove: (id: string, force = false) => api<{ moved: string[]; lost: string[]; status: MachinesStatus }>(`/api/machines/${encodeURIComponent(id)}${force ? "?force=1" : ""}`, { method: "DELETE" }),
  saveSettings: (s: MachineSettings) => api<MachinesStatus>("/api/machines/settings", { method: "PUT", body: s }),
}

/** A machine action whose reply carries every machine's status. Errors toast unless `quiet` (the form shows them). */
export function useMachineAction<T>(title: string, call: (input: T) => Promise<{ status: MachinesStatus } | MachinesStatus>, o: { quiet?: boolean } = {}) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: call,
    onSuccess: (r) => qc.setQueryData(keys.machines, "machines" in r ? r : r.status),
    onError: o.quiet ? undefined : fail(title),
  })
}

// ------------------------------------------------------------------ identities (Settings › Identities)

/** Every identity, its secrets as fingerprints only. The "identities" event keeps it live. */
export const useIdentities = (o?: Quiet) => useQuery({ queryKey: keys.identities, queryFn: () => api<Identity[]>("/api/identities"), notifyOnChangeProps: o?.notifyOnChangeProps })

/** The calls Settings › Identities makes; every one answers with fingerprints, never a secret. */
export const identityApi = {
  create: (input: IdentityInput & { name: string }) => api<Identity>("/api/identities", { body: input }),
  update: (id: string, patch: IdentityInput) => api<Identity>(`/api/identities/${id}`, { method: "PATCH", body: patch }),
  remove: (id: string) => api<{ movedProjectIds: string[] }>(`/api/identities/${id}?moveProjects=1`, { method: "DELETE" }),
  saveToken: (id: string, owner: string, token: string) => api<Identity>(`/api/identities/${id}/tokens`, { method: "PUT", body: { owner, token } }),
  removeToken: (id: string, owner: string) => api<Identity>(`/api/identities/${id}/tokens?owner=${encodeURIComponent(owner)}`, { method: "DELETE" }),
  saveClaude: (id: string, kind: IdentityClaudeKind, value: string) => api<Identity>(`/api/identities/${id}/claude`, { method: "PUT", body: { kind, value } }),
  removeClaude: (id: string) => api<Identity>(`/api/identities/${id}/claude`, { method: "DELETE" }),
  saveSigning: (id: string, input: IdentitySigningInput) => api<Identity>(`/api/identities/${id}/signing`, { method: "PUT", body: input }),
  setRequireSigned: (id: string, requireSigned: boolean) => api<Identity>(`/api/identities/${id}/signing`, { method: "PATCH", body: { requireSigned } }),
  removeSigning: (id: string) => api<Identity>(`/api/identities/${id}/signing`, { method: "DELETE" }),
  /** One detection proposal becomes an identity (or updates the one for its login); `lines` say what happened. */
  importDetected: (input: { login: string; projects?: string[] }) => api<{ identity: Identity; created: boolean; lines: string[] }>("/api/identities/import", { body: input }),
}

/** Read this computer's gh, git and ssh (and, online, GitHub) for proposals. Changes nothing. */
export const useDetectIdentities = () => useMutation({ mutationFn: (online: boolean) => api<IdentityDetection>("/api/identities/detect", { body: { online } }) })

/** Check an identity with GitHub; the result is saved as its last test (the "identities" event brings it). */
export function useTestIdentity() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api<IdentityCheckResult>(`/api/identities/${id}/test`, { method: "POST" }),
    onSuccess: (lastCheck, id) => qc.setQueryData<Identity[]>(keys.identities, (list) => list?.map((i) => (i.id === id ? { ...i, lastCheck } : i))),
  })
}

// ------------------------------------------------------------------ connectors (Settings › Connectors)

/** Every connector, its secrets as fingerprints only. The "connectors" event keeps it live. */
export const useConnectors = (o?: Quiet) => useQuery({ queryKey: keys.connectors, queryFn: () => api<Connector[]>("/api/connectors"), notifyOnChangeProps: o?.notifyOnChangeProps })

const connectorPath = (id: string, rest = "") => `/api/connectors/${encodeURIComponent(id)}${rest}`

/** The calls Settings › Connectors makes. Secrets go in; every answer has fingerprints only. */
export const connectorApi = {
  create: (input: ConnectorInput) => api<Connector>("/api/connectors", { body: input }),
  update: (id: string, patch: ConnectorInput) => api<Connector>(connectorPath(id), { method: "PATCH", body: patch }),
  remove: (id: string) => api<{ ok: true }>(connectorPath(id), { method: "DELETE" }),
  saveToken: (id: string, value: string) => api<Connector>(connectorPath(id, "/token"), { method: "PUT", body: { value } }),
  removeToken: (id: string) => api<Connector>(connectorPath(id, "/token"), { method: "DELETE" }),
  saveClientSecret: (id: string, value: string) => api<Connector>(connectorPath(id, "/client-secret"), { method: "PUT", body: { value } }),
  removeClientSecret: (id: string) => api<Connector>(connectorPath(id, "/client-secret"), { method: "DELETE" }),
  saveEnv: (id: string, name: string, value: string) => api<Connector>(connectorPath(id, `/env/${encodeURIComponent(name)}`), { method: "PUT", body: { value } }),
  removeEnv: (id: string, name: string) => api<Connector>(connectorPath(id, `/env/${encodeURIComponent(name)}`), { method: "DELETE" }),
  /** The provider's sign-in page, returning to `origin` (this page's) when the server allows it. */
  startSignIn: (id: string, origin: string) => api<ConnectorSignIn>(connectorPath(id, "/oauth/start"), { body: { origin } }),
  /** Paste-back: the address the provider's page ended up on. */
  completeSignIn: (url: string) => api<Connector>("/api/connectors/oauth/complete", { body: { url } }),
  signOut: (id: string) => api<Connector>(connectorPath(id, "/sign-out"), { method: "POST" }),
  test: (id: string) => api<Connector>(connectorPath(id, "/test"), { method: "POST" }),
}

/** Connect to a connector and list its tools; the answer (also sent as the "connectors" event) goes in the cache. */
export function useTestConnector() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => connectorApi.test(id),
    onSuccess: (c) => qc.setQueryData<Connector[]>(keys.connectors, (list) => list?.map((x) => (x.id === c.id ? c : x))),
  })
}

// ------------------------------------------------------------------ hooks (automations on task events)

export const useHooks = (scope: string) => useQuery({ queryKey: keys.hooks(scope), queryFn: () => api<HookWithLastRun[]>(`/api/hooks?${hookQuery(scope)}`) })
export const useHookRuns = (scope: string) =>
  useQuery({ queryKey: keys.hookRuns(scope), queryFn: () => api<HookRun[]>(`/api/hooks/runs?${hookQuery(scope)}&limit=200`) })
export const useHookTemplates = () => useQuery({ queryKey: keys.hookTemplates, queryFn: () => api<HookTemplateView[]>("/api/hooks/templates"), staleTime: Infinity })

function useHookMutation<V, R>(fn: (v: V) => Promise<R>, what: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onError: fail(`Couldn't ${what}`),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["hooks"] })
      void qc.invalidateQueries({ queryKey: ["hook-runs"] })
    },
  })
}

export const useCreateHook = () => useHookMutation((input: HookInput) => api<Hook>("/api/hooks", { body: input }), "create the hook")
export const useUpdateHook = () =>
  useHookMutation(({ id, ...patch }: { id: string } & Partial<HookInput>) => api<Hook>(`/api/hooks/${id}`, { method: "PATCH", body: patch }), "update the hook")
export const useDeleteHook = () => useHookMutation((id: string) => api(`/api/hooks/${id}`, { method: "DELETE" }), "delete the hook")
export const useHookFromTemplate = () =>
  useHookMutation((v: { projectId: string | null; template: string }) => api<Hook>("/api/hooks/from-template", { body: v }), "add the hook")

/** Optimistic on/off: the switch flips at once and flips back if the server says no. */
export function useToggleHook(scope: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api<Hook>(`/api/hooks/${id}`, { method: "PATCH", body: { enabled } }),
    onMutate: async ({ id, enabled }) => {
      await qc.cancelQueries({ queryKey: keys.hooks(scope) })
      const undo = snapshot<HookWithLastRun[]>(qc, keys.hooks(scope))
      qc.setQueryData<HookWithLastRun[]>(keys.hooks(scope), (list) => list?.map((h) => (h.id === id ? { ...h, enabled } : h)))
      return { undo }
    },
    onError: (err, _v, ctx) => {
      ctx?.undo()
      fail("Couldn't switch the hook")(err)
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ["hooks"] }),
  })
}

export function useCreateProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: string; name: string; description?: string; repo?: string | null; baseBranch?: string; env?: Record<string, string>; runner?: Runner; machineLabel?: string | null; agentCli?: AgentCli | null }) =>
      api<Project>("/api/projects", { body: input }),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: keys.projects })
      const undo = snapshot<Project[]>(qc, keys.projects)
      const now = Date.now()
      qc.setQueryData<Project[]>(keys.projects, (list) =>
        upsert(list, {
          id: input.id,
          name: input.name,
          description: input.description ?? "",
          repo: input.repo || null,
          baseBranch: input.baseBranch || "main",
          envKeys: Object.keys(input.env ?? {}),
          notes: [],
          notesMaxCount: null,
          notesMaxTokens: null,
          boxSize: null,
          partialClone: null,
          pushAtTurnEnd: null,
          depCache: null,
          closeIssuesOnMerge: null,
          autoDoneOnMerge: null,
          // Unless the form picked one, the server uses the setup choice.
          runner: input.runner ?? qc.getQueryData<SetupStatus>(keys.setup)?.runner.default ?? "box",
          machineLabel: input.machineLabel ?? null,
          agentCli: input.agentCli ?? null,
          agentsPerBox: null,
          wholeMachine: false,
          tasksPerBox: null,
          maxBoxes: null,
          gpuMaxHourlyUsd: null,
          gpuMachine: { gpuTypes: null, cloud: null, minRamGb: null, minVcpus: null },
          gpuProvider: !input.runner && qc.getQueryData<SetupStatus>(keys.setup)?.runner.provider === "daytona" ? "daytona" : null,
          docker: { image: null, dockerfile: null },
          identityId: DEFAULT_IDENTITY_ID,
          snapshot: null,
          color: null,
          iconUrl: null,
          captainIcon: null,
          createdAt: now,
          updatedAt: now,
        }),
      )
      return { undo }
    },
    onError: (err, _input, ctx) => {
      ctx?.undo()
      fail("Couldn't create the project")(err)
    },
    onSuccess: (project) => qc.setQueryData<Project[]>(keys.projects, (list) => upsert(list, project)),
  })
}

export function useUpdateProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      ...patch
    }: {
      id: string
      name?: string
      description?: string
      repo?: string | null
      baseBranch?: string
      env?: Record<string, string>
      removeEnv?: string[]
      boxSize?: BoxSize | null
      partialClone?: boolean | null
      notesMaxCount?: number | null
      notesMaxTokens?: number | null
      pushAtTurnEnd?: boolean | null
      depCache?: boolean | null
      /** When its PRs merge; null uses Settings › Coordinator's. */
      closeIssuesOnMerge?: boolean | null
      autoDoneOnMerge?: boolean | null
      runner?: Runner
      /** Runs on: SSH machine: the machines' label or name; null is any machine. */
      machineLabel?: string | null
      /** Claude Code, Codex or Cursor for its new tasks; null uses Settings › Box agents. */
      agentCli?: AgentCli | null
      agentsPerBox?: number | null
      wholeMachine?: boolean
      tasksPerBox?: number | null
      maxBoxes?: number | null
      /** Both fields: the optimistic update replaces the project's whole `docker`. */
      docker?: ProjectDocker
      identityId?: string
      /** null goes back to the colour from its name. */
      color?: ProjectColor | null
      /** Its Captain's icon; null is Use default (its image, else Settings › Coordinator's). */
      captainIcon?: CaptainIconId | null
    }) =>
      api<Project>(`/api/projects/${id}`, { method: "PATCH", body: patch }),
    onMutate: async ({ id, env, removeEnv, ...patch }) => {
      await qc.cancelQueries({ queryKey: keys.projects })
      const undo = snapshot<Project[]>(qc, keys.projects)
      qc.setQueryData<Project[]>(keys.projects, (list) =>
        list?.map((p) =>
          p.id === id
            ? {
                ...p,
                ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
                envKeys: [...new Set([...p.envKeys.filter((k) => !removeEnv?.includes(k)), ...Object.keys(env ?? {})])],
              }
            : p,
        ),
      )
      return { undo }
    },
    onError: (err, _v, ctx) => {
      ctx?.undo()
      fail("Couldn't save the project")(err)
    },
    onSuccess: (project) => qc.setQueryData<Project[]>(keys.projects, (list) => upsert(list, project)),
  })
}

/**
 * Set (an image) or take off (null) a project's own icon. Settings applies it on Save, so the form shows the server's
 * refusal itself (the dialog covers toasts).
 */
export function useSetProjectIcon() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, file }: { id: string; file: Blob | null }) =>
      file ? api<Project>(`/api/projects/${id}/icon`, { method: "PUT", raw: file }) : api<Project>(`/api/projects/${id}/icon`, { method: "DELETE" }),
    onSuccess: (project) => qc.setQueryData<Project[]>(keys.projects, (list) => upsert(list, project)),
  })
}

type DeleteInput = string | { id: string; ifResting: true; discardQueued?: number }
const deleteId = (input: DeleteInput) => typeof input === "string" ? input : input.id
const deleteQuery = (input: DeleteInput) => typeof input === "string" ? "" : `?ifResting=1${input.discardQueued ? `&discardQueued=${input.discardQueued}` : ""}`

export function useDeleteProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: DeleteInput) => api(`/api/projects/${deleteId(input)}${deleteQuery(input)}`, { method: "DELETE" }),
    onMutate: async (input) => {
      const id = deleteId(input)
      const undoP = snapshot<Project[]>(qc, keys.projects)
      const undoT = snapshot<Task[]>(qc, keys.tasks)
      qc.setQueryData<Project[]>(keys.projects, (list) => list?.filter((p) => p.id !== id))
      qc.setQueryData<Task[]>(keys.tasks, (list) => list?.filter((t) => t.projectId !== id))
      return { undo: () => (undoP(), undoT()) }
    },
    onError: (err, _v, ctx) => {
      ctx?.undo()
      fail("Couldn't delete the project")(err)
    },
  })
}

export function useCreateTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      id: string
      projectId: string
      title: string
      prompt: string
      env?: Record<string, string>
      model?: string
      effort?: Effort
      /** Upload ids. */
      attachments?: string[]
      /** Run on this computer (or a box) over the project's "Runs on". */
      runsOn?: Runner
      /** With runsOn "ssh": the SSH machines' label or name. */
      machineLabel?: string | null
      /** Run on Claude Code, Codex or Cursor over the project's Agent. */
      agentCli?: AgentCli
    }) =>
      api<Task>("/api/tasks", { body: input }),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: keys.tasks })
      const undo = snapshot<Task[]>(qc, keys.tasks)
      const now = Date.now()
      qc.setQueryData<Task[]>(keys.tasks, (list) =>
        upsert(list, {
          id: input.id,
          projectId: input.projectId,
          title: input.title,
          prompt: input.prompt,
          status: "queued",
          boxId: null,
          sessionId: "",
          branch: null,
          prUrl: null,
          prState: null,
          prMergedAt: null,
          prMergedBy: null,
          previews: [],
          question: null,
          summary: null,
          error: null,
          waitReason: null,
          waitBoxSize: null,
          waitFor: [],
          turnCount: 0,
          pendingCount: 0,
          lastArchivedAt: null,
          scheduleId: null,
          outcome: null,
          contextTokens: null,
          contextWindow: null,
          compactPending: false,
          compacting: false,
          // The server settles it (the project's Agent, else Settings); this is only the card until it answers.
          agentCli: input.agentCli ?? qc.getQueryData<Project[]>(keys.projects)?.find((p) => p.id === input.projectId)?.agentCli ?? "claude",
          model: null,
          effort: null,
          claudeCostUsd: 0,
          claudeTokens: 0,
          routingRule: null,
          routingReason: null,
          runsOn: input.runsOn ?? null,
          machineLabel: input.runsOn === "ssh" ? (input.machineLabel ?? null) : null,
          createdAt: now,
          updatedAt: now,
        }),
      )
      return { undo }
    },
    onError: (err, _v, ctx) => {
      ctx?.undo()
      playSendSound("failed")
      fail("Couldn't start the task")(err)
    },
    onSuccess: (task) => {
      playSendSound()
      qc.setQueryData<Task[]>(keys.tasks, (list) => upsert(list, task))
      // The task page opens before the server answers, so its thread may have loaded empty; the prompt isn't streamed.
      void qc.invalidateQueries({ queryKey: keys.taskMessages(task.id) })
    },
  })
}

/** The server refused it, rather than a failure to reach the server. */
export const refused = (err: unknown) => err instanceof ApiError && err.status >= 400

/** `quiet`: errors it says nothing about because the caller handles them. */
export function useSendTaskMessage(taskId: string, { quiet }: { quiet?: (err: Error) => boolean } = {}) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: { id?: string; content: string; attachments?: Attachment[]; taskId?: string }): Promise<Task & { inputId?: string }> => {
      const destinationId = input.taskId ?? taskId
      try {
        return await api<Task & { inputId?: string }>(`/api/tasks/${destinationId}/messages`, { body: { id: input.id, content: input.content, attachments: input.attachments?.map((a) => a.id) } })
      } catch (err) {
        // The response can be lost after SSE already confirmed storage/delivery. Don't restore a duplicate draft.
        const confirmed = qc.getQueryData<TaskMessage[]>(keys.taskMessages(destinationId))?.some((m) => submissionId(m) === input.id && !m.meta?.pending)
          || qc.getQueryData<QueuedMessage[]>(keys.taskQueue(destinationId))?.some((m) => m.clientMessageId === input.id && !m.id.startsWith("tmp-"))
        const task = qc.getQueryData<Task[]>(keys.tasks)?.find((t) => t.id === destinationId)
        if (confirmed && task) return task
        throw err
      }
    },
    onMutate: (input) => {
      const { content, attachments, taskId: destinationId = taskId } = input
      const id = input.id ??= clientId("chat")
      const task = qc.getQueryData<Task[]>(keys.tasks)?.find((t) => t.id === destinationId)
      const waiting = taskMustWait(task)
      const now = Date.now()
      qc.setQueryData<QueuedMessage[]>(keys.taskQueue(destinationId), (list) => [
        ...(list ?? []),
        { id: `tmp-${id}`, clientMessageId: id, taskId: destinationId, source: "cody", kind: "owner", sender: "", text: content, attachments: attachments ?? [], status: "queued", version: 1, createdAt: now, updatedAt: now },
      ])
      if (!waiting) qc.setQueryData<TaskMessage[]>(keys.taskMessages(destinationId), (list) => upsert(list, {
        id, taskId: destinationId, role: "user", content, createdAt: now,
        meta: { pending: true, source: "cody", clientMessageId: id, ...(attachments?.length ? { attachments } : {}) },
      }))
      return { taskAtSend: task }
    },
    onError: (err, input) => {
      const destinationId = input.taskId ?? taskId
      // Undo only this send; newer sends and live messages are independent.
      qc.setQueryData<TaskMessage[]>(keys.taskMessages(destinationId), (list) => list?.filter((m) => m.id !== input.id || !m.meta?.pending))
      qc.setQueryData<QueuedMessage[]>(keys.taskQueue(destinationId), (list) => list?.filter((m) => m.id !== `tmp-${input.id}`))
      void qc.invalidateQueries({ queryKey: keys.tasks })
      if (quiet?.(err)) return
      playSendSound("failed")
      fail("Couldn't send the message")(err)
    },
    onSuccess: (task, input, ctx) => {
      const destinationId = input.taskId ?? taskId
      playSendSound()
      // A newer SSE task (or another send/Stop) is authoritative over this response's snapshot.
      const current = qc.getQueryData<Task[]>(keys.tasks)?.find((t) => t.id === destinationId)
      if (!staleAfterStop(task) && current === ctx?.taskAtSend) qc.setQueryData<Task[]>(keys.tasks, (list) => upsert(list, task))
      taskSubmissionWait(qc, current !== ctx?.taskAtSend && current ? current : task)
      qc.setQueryData<QueuedMessage[]>(keys.taskQueue(destinationId), (list) => list?.map((m) => m.id === `tmp-${input.id}` && task.inputId ? { ...m, id: task.inputId } : m))
      // Owner close commands don't enqueue input.
      if (task.status === "done" && !task.inputId) {
        qc.setQueryData<TaskMessage[]>(keys.taskMessages(destinationId), (list) => list?.filter((m) => m.id !== input.id || !m.meta?.pending))
        qc.setQueryData<QueuedMessage[]>(keys.taskQueue(destinationId), (list) => list?.filter((m) => m.id !== `tmp-${input.id}`))
      }
      void qc.invalidateQueries({ queryKey: keys.taskQueue(destinationId) })
      if (!qc.getQueryData<TaskMessage[]>(keys.taskMessages(destinationId))?.some((m) => submissionId(m) === input.id && !m.meta?.pending)) {
        void qc.invalidateQueries({ queryKey: keys.taskMessages(destinationId) })
      }
    },
  })
}

/**
 * Answer a task's several questions (ask_user's `questions`, components/AskQuestions.tsx): the server writes them as
 * one message to the task's session (TaskManager.answerQuestions), queued like a typed answer. `key` is the askKey of
 * the questions shown; a 409 means they were answered or replaced meanwhile. The form shows the error itself.
 */
export function useAnswerQuestions(taskId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { key: string; answers: string[] }) =>
      api<Task & { inputId?: string }>(`/api/tasks/${encodeURIComponent(taskId)}/answers`, { body: { id: clientId("chat"), key: input.key, answers: input.answers } }),
    onSuccess: (task) => {
      playSendSound()
      if (!staleAfterStop(task)) qc.setQueryData<Task[]>(keys.tasks, (list) => upsert(list, task))
      void qc.invalidateQueries({ queryKey: keys.taskQueue(taskId) })
      void qc.invalidateQueries({ queryKey: keys.taskMessages(taskId) })
    },
    onError: () => {
      playSendSound("failed")
      void qc.invalidateQueries({ queryKey: keys.tasks })
    },
  })
}

/**
 * Send a task-chat message to the task's project's Captain instead of its agent (TaskManager.forwardToCaptain). Shows
 * at once as a pending "→ Captain" line; the server's task.message replaces it (stream.ts matches tmp- by content).
 */
export function useForwardToCaptain(taskId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { content: string; attachments?: Attachment[] }) =>
      api<TaskMessage>(`/api/tasks/${taskId}/captain`, { body: { content: input.content, attachments: input.attachments?.map((a) => a.id) } }),
    onMutate: async ({ content, attachments }) => {
      const undo = snapshot<TaskMessage[]>(qc, keys.taskMessages(taskId))
      const now = Date.now()
      const meta = { kind: "to_captain", pending: true, ...(attachments?.length ? { attachments } : {}) }
      const line: TaskMessage = { id: `tmp-${now}`, taskId, role: "event", content: content.trim(), meta, createdAt: now }
      qc.setQueryData<TaskMessage[]>(keys.taskMessages(taskId), (list) => (list ? [...list, line] : list))
      return { undo, tmp: line.id }
    },
    onError: (err, _v, ctx) => {
      ctx?.undo()
      playSendSound("failed")
      fail("Couldn't send it to the Captain")(err)
    },
    onSuccess: (msg, _v, ctx) => {
      playSendSound()
      qc.setQueryData<TaskMessage[]>(keys.taskMessages(taskId), (list) => {
        if (!list) return list
        const rest = list.filter((m) => m.id !== ctx?.tmp)
        return rest.some((m) => m.id === msg.id) ? rest : [...rest, msg]
      })
    },
  })
}

/** Put a task back as it was before an optimistic change, and ask the server, which may have moved on since. */
function restoreTask(qc: QueryClient, taskId: string, before: Task | undefined) {
  if (before) qc.setQueryData<Task[]>(keys.tasks, (list) => list?.map((t) => (t.id === taskId ? before : t)))
  void qc.invalidateQueries({ queryKey: keys.tasks })
}

/**
 * Stop, Mark done (close) and Retry: the task changes in the cache at once. A failure puts that task back as it was
 * (and asks the server, which may have moved on) with a toast. A close also keeps the task done against late SSE
 * updates and fetches older than it (lib/closedTasks.ts); a stop keeps it stopped while the server still reports the
 * turn it is ending (lib/stoppedTasks.ts).
 */
function useTaskAction(action: "stop" | "close" | "retry", optimistic: (t: Task) => Partial<Task>, label: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (taskId: string) => api<Task>(`/api/tasks/${taskId}/${action}`, { method: "POST" }),
    onMutate: (taskId) => {
      const before = qc.getQueryData<Task[]>(keys.tasks)?.find((t) => t.id === taskId)
      if (action === "close") closeSent(taskId, before)
      if (action === "stop" && before) stopSent(before)
      if (before) patchTask(qc, taskId, optimistic(before))
      return { before }
    },
    onError: (err, taskId, ctx) => {
      // A Mark done from a card was done in the cache since its click: that copy is the one to go back to.
      const before = (action === "close" ? closeFailed(taskId) : undefined) ?? ctx?.before
      if (action === "stop") stopFailed(taskId)
      restoreTask(qc, taskId, before)
      fail(`Couldn't ${label}`)(err)
    },
    onSuccess: (task) => {
      if (action === "close") closeLanded(task)
      // Still the turn being stopped: its end brings the server's copy. A turn that outlives the hold shows again.
      if (staleAfterStop(task)) {
        setTimeout(() => {
          if (stopExpired(task.id)) void qc.invalidateQueries({ queryKey: keys.tasks })
        }, STOP_GUARD_MS)
        return
      }
      qc.setQueryData<Task[]>(keys.tasks, (list) => upsert(list, task))
    },
  })
}

/**
 * The "Merge PR" button: POST /api/tasks/:id/merge. The button guards against double sends (lib/mergePr.ts). The
 * request is pending in the cache from the click ("merge queued", as the server's answer starts it); a failure takes
 * it back and asks the server.
 */
export function useRequestMerge() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (taskId: string) => api<{ task: Task; delivery: "now" | "queued" }>(`/api/tasks/${taskId}/merge`, { method: "POST" }),
    onMutate: (taskId) => {
      const task = qc.getQueryData<Task[]>(keys.tasks)?.find((t) => t.id === taskId)
      const n = Number(prNumber(task?.prUrl))
      if (!task?.prUrl || !n || task.mergeRequest) return { shown: false }
      patchTask(qc, taskId, { mergeRequest: { prNumber: n, prUrl: task.prUrl, requestedAt: Date.now(), deliveredAt: null, requestedBy: null } })
      return { shown: true }
    },
    onError: (err, taskId, ctx) => {
      if (ctx?.shown) {
        patchTask(qc, taskId, { mergeRequest: null })
        void qc.invalidateQueries({ queryKey: keys.tasks })
      }
      fail("Couldn't request the merge")(err)
    },
    onSuccess: ({ task, delivery }) => {
      qc.setQueryData<Task[]>(keys.tasks, (list) => upsert(list, task))
      if (delivery === "queued") toast.info("Merge request queued", `${task.title} is mid-turn; the request goes out when that turn ends.`)
      else toast.info("Merge requested", task.title)
    },
  })
}

/** Task options › Done when its PR merges: stayOpenOnMerge keeps a long-running task open when its PR merges. */
export function useSetStayOpenOnMerge() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ taskId, stayOpen }: { taskId: string; stayOpen: boolean }) => api<Task>(`/api/tasks/${taskId}`, { method: "PATCH", body: { stayOpenOnMerge: stayOpen } }),
    onMutate: ({ taskId, stayOpen }) => {
      const undo = snapshot<Task[]>(qc, keys.tasks)
      patchTask(qc, taskId, { stayOpenOnMerge: stayOpen })
      return { undo }
    },
    onError: (err, _v, ctx) => {
      ctx?.undo()
      fail("Couldn't change the task's option")(err)
    },
    onSuccess: (task) => qc.setQueryData<Task[]>(keys.tasks, (list) => upsert(list, task)),
  })
}

export const useStopTask = () => useTaskAction("stop", stoppedPatch, "stop the task")
export const useCloseTask = () => useTaskAction("close", () => ({ status: "done" as TaskStatus, question: null }), "close the task")
export const useRetryTask = () => useTaskAction("retry", () => ({ status: "queued" as TaskStatus, error: null }), "retry the task")

export function useContinueTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ taskId, ...options }: TaskContinuation & { taskId: string }) => api<Task>(`/api/tasks/${taskId}/continue`, { method: "POST", body: options }),
    onSuccess: (task) => qc.setQueryData<Task[]>(keys.tasks, (list) => upsert(list, task)),
    onError: fail("Couldn't continue the task"),
  })
}

/**
 * "Mark done" for one task or several (the Cards view's selection, "Mark all idle as done"): the same close as the task
 * view's and close_task's, each sent after a short undo window. The tasks are done in the cache from the click, so every
 * list, count and badge drops them at once, not when the close goes out. One toast, whose Undo takes them all back.
 */
export function useMarkTasksDone() {
  const qc = useQueryClient()
  const { mutateAsync } = useCloseTask()
  const reopen = useReopenTask()
  return useCallback(
    (tasks: readonly Pick<Task, "id" | "title">[]) => {
      const marked = tasks.filter((t) => deferClose(t.id, () => mutateAsync(t.id), UNDO_MS, () => restoreTask(qc, t.id, closeFailed(t.id))))
      if (!marked.length) return
      for (const t of marked) {
        closeSent(t.id, qc.getQueryData<Task[]>(keys.tasks)?.find((c) => c.id === t.id))
        patchTask(qc, t.id, { status: "done", question: null })
      }
      // Undo is a reopen: in the window nothing was sent, and a close that went out already is reopened on the server.
      const undo = () => marked.forEach((t) => void reopen(t.id))
      const body = marked.length === 1 ? marked[0]!.title : "Messaging one picks it back up."
      toast.info(marked.length === 1 ? "Marked done" : `Marked ${marked.length} tasks done`, body, { action: { label: "Undo", onClick: undo }, duration: UNDO_MS })
    },
    [mutateAsync, reopen],
  )
}

/** Reopens on their way, so a double tap sends one (and waits for it). */
const reopening = new Map<string, Promise<boolean>>()

/**
 * Undo Mark done: the toast's Undo and a done task's Reopen. In the undo window the close was never sent, so the task
 * is just as it was. After it, POST /api/tasks/:id/reopen (once a close on its way has landed) puts the task back in
 * the status it had, its PR state kept. Neither starts a turn. Resolves whether the task is open again.
 */
export function useReopenTask(): (taskId: string) => Promise<boolean> {
  const qc = useQueryClient()
  const { mutateAsync } = useMutation({
    mutationFn: (taskId: string) => api<Task>(`/api/tasks/${taskId}/reopen`, { method: "POST" }),
    onSuccess: (task) => {
      closeUndone(task.id)
      qc.setQueryData<Task[]>(keys.tasks, (list) => upsert(list, task))
    },
    onError: (err) => {
      void qc.invalidateQueries({ queryKey: keys.tasks })
      fail("Couldn't reopen the task")(err)
    },
  })
  return useCallback(
    async (taskId: string) => {
      if (undoClose(taskId)) return true
      // A close that failed left the task open: nothing to reopen.
      const sending = closeInFlight(taskId)
      if (sending && !(await sending)) return true
      const pending = reopening.get(taskId)
      if (pending) return pending
      const done = mutateAsync(taskId).then(
        () => true,
        () => false,
      )
      reopening.set(taskId, done)
      void done.finally(() => reopening.delete(taskId))
      return done
    },
    [mutateAsync],
  )
}

export function useDeleteTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: DeleteInput) => api(`/api/tasks/${deleteId(input)}${deleteQuery(input)}`, { method: "DELETE" }),
    onMutate: async (input) => {
      const taskId = deleteId(input)
      const undo = snapshot<Task[]>(qc, keys.tasks)
      qc.setQueryData<Task[]>(keys.tasks, (list) => list?.filter((t) => t.id !== taskId))
      return { undo }
    },
    onError: (err, _v, ctx) => {
      ctx?.undo()
      fail("Couldn't delete the task")(err)
    },
  })
}

export interface ScheduleInput {
  id: string
  target: ScheduleTarget
  /** Null for Coordinator schedules (stored as target "orchestrator" for compatibility). */
  projectId: string | null
  runsOn?: Runner | null
  name: string
  cron: string
  timezone: string
  prompt: string
  catchUp: CatchUp
  allowOverlap: boolean
}

export function useCreateSchedule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: ScheduleInput) => api<Schedule>("/api/schedules", { body: input }),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: keys.schedules })
      const undo = snapshot<Schedule[]>(qc, keys.schedules)
      const now = Date.now()
      qc.setQueryData<Schedule[]>(keys.schedules, (list) =>
        upsert(list, {
          ...input,
          runsOn: input.runsOn ?? null,
          enabled: true,
          nextRunAt: null,
          lastRunAt: null,
          lastTaskId: null,
          lastSkipReason: null,
          runCount: 0,
          qstashId: null,
          createdAt: now,
          updatedAt: now,
        }),
      )
      return { undo }
    },
    onError: (err, _v, ctx) => {
      ctx?.undo()
      fail("Couldn't create the schedule")(err)
    },
    onSuccess: (schedule) => qc.setQueryData<Schedule[]>(keys.schedules, (list) => upsert(list, schedule)),
  })
}

export function useUpdateSchedule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string } & Partial<Omit<ScheduleInput, "id" | "projectId" | "target">> & { enabled?: boolean }) =>
      api<Schedule>(`/api/schedules/${id}`, { method: "PATCH", body: patch }),
    onMutate: async ({ id, ...patch }) => {
      const undo = snapshot<Schedule[]>(qc, keys.schedules)
      qc.setQueryData<Schedule[]>(keys.schedules, (list) => list?.map((s) => (s.id === id ? { ...s, ...patch } : s)))
      return { undo }
    },
    onError: (err, _v, ctx) => {
      ctx?.undo()
      fail("Couldn't update the schedule")(err)
    },
    onSuccess: (schedule) => qc.setQueryData<Schedule[]>(keys.schedules, (list) => upsert(list, schedule)),
  })
}

export function useDeleteSchedule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api(`/api/schedules/${id}`, { method: "DELETE" }),
    onMutate: async (id) => {
      const undo = snapshot<Schedule[]>(qc, keys.schedules)
      qc.setQueryData<Schedule[]>(keys.schedules, (list) => list?.filter((s) => s.id !== id))
      return { undo }
    },
    onError: (err, _v, ctx) => {
      ctx?.undo()
      fail("Couldn't delete the schedule")(err)
    },
  })
}

export function useRunSchedule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api<Task | ScheduleRun>(`/api/schedules/${id}/run`, { method: "POST" }),
    onError: fail("Couldn't start a run"),
    onSuccess: (run) => {
      if ("dueAt" in run) qc.setQueryData<ScheduleRun[]>(keys.scheduleRuns, (list) => upsert(list, run, true))
      else qc.setQueryData<Task[]>(keys.tasks, (list) => upsert(list, run))
    },
  })
}

/** What Clear box / Delete box would touch, fetched fresh each time a confirmation opens. */
export const useBoxContents = (boxId: string) =>
  useQuery({ queryKey: ["box-contents", boxId], queryFn: () => api<BoxContents>(`/api/boxes/${encodeURIComponent(boxId)}/contents`), staleTime: 0, gcTime: 0 })

/** Archive every workspace and take it off the box. Resolves with the finished report (SSE box.cleanup toasts it). */
export function useClearBox() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { boxId: string; stopAgents: boolean }) => api<BoxCleanup>(`/api/boxes/${encodeURIComponent(input.boxId)}/clear`, { body: { stopAgents: input.stopAgents } }),
    onSuccess: (cleanup) => qc.setQueryData<BoxInfo[]>(keys.boxes, (list) => withCleanup(list, cleanup)),
    // Not awaited: the dialog closes as soon as the server answers.
    onSettled: () => void qc.invalidateQueries({ queryKey: keys.boxes }),
  })
}

/** The box size auto-sizing picks for a project from its measured runs, for its Box size setting. It moves only as turns end. */
export const useProjectAutoSize = (projectId: string) =>
  useQuery({ queryKey: keys.projectAutoSize(projectId), queryFn: () => api<ProjectAutoSize>(`/api/projects/${encodeURIComponent(projectId)}/auto-size`), staleTime: 30_000 })

/**
 * Archive every workspace, then destroy the box at the provider, terminate a RunPod GPU pod (its volume stays), or
 * delete a project's Docker container and its volume.
 * `stopAgents` stops running agents first; `override` deletes past the safety check (Delete anyway).
 */
export function useDeleteBox() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { boxId: string; stopAgents: boolean; override?: boolean }) => {
      const query = new URLSearchParams({ ...(input.stopAgents ? { stopAgents: "1" } : {}), ...(input.override ? { override: "1" } : {}) }).toString()
      return api<{ ok: true; kind: "box" | "pod" | "container"; label: string }>(`/api/boxes/${encodeURIComponent(input.boxId)}${query ? `?${query}` : ""}`, { method: "DELETE" })
    },
    onSuccess: (res, input) => {
      qc.setQueryData<BoxInfo[]>(keys.boxes, (list) => list?.filter((b) => b.id !== input.boxId))
      if (res.kind === "pod")
        toast.info(
          `Terminated ${res.label}`,
          gpuBoxProvider(input.boxId) === "runpod"
            ? "Every workspace was archived first and its network volume stays. Its tasks start a new pod on their next message."
            : `Every workspace was archived first, then its disk went with it. Its tasks start a new ${GPU_POD_NOUN[gpuBoxProvider(input.boxId) ?? "runpod"]} on their next message.`,
        )
      else if (res.kind === "container") toast.info(`Deleted ${res.label}`, "Every workspace was archived first, then the container and its volume went. Its tasks start a new container on their next message.")
      else toast.info(`Deleted ${input.boxId}`, "Every workspace was archived first. Its tasks move to another box on their next message.")
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.boxes })
      void qc.invalidateQueries({ queryKey: keys.tasks })
      void qc.invalidateQueries({ queryKey: keys.runpod })
      void qc.invalidateQueries({ queryKey: keys.vast })
      void qc.invalidateQueries({ queryKey: keys.daytona })
      void qc.invalidateQueries({ queryKey: keys.docker })
    },
  })
}

/**
 * A chat send: the text, its files, and the "@" and "!" picks, and the Coordinator's "%" (shared/runTargets.ts), the
 * whole message's; `inline`: picks typed for only part of it (scopePicks).
 */
type ChatSend = { id: string; content: string; attachments?: Attachment[]; runsOn?: RunTargetPick | null; agent?: RunTargetPick | null; project?: RunTargetPick | null; inline?: InlinePick[] }

/** A chat message as the server takes it: attachment ids, and the "@", "!" and "%" picks as their values. */
function sendBody(input: ChatSend) {
  return {
    id: input.id,
    content: input.content,
    attachments: input.attachments?.map((a) => a.id),
    ...(input.runsOn ? { runsOn: input.runsOn.value } : {}),
    ...(input.agent ? { agent: input.agent.token } : {}),
    ...(input.project ? { project: input.project.value } : {}),
    // A harness goes as its token, as `agent` does, so a model and effort typed after it go too.
    ...(input.inline?.length ? { inline: input.inline.map((p) => ({ kind: p.kind, value: p.kind === "agent" ? p.token : p.value, where: p.where, reason: p.reason })) } : {}),
  }
}

/** The picks as a sent message's meta shows them (its chips), before the server echoes it. */
const pickMeta = (input: ChatSend) => ({
  ...(input.runsOn ? { runsOn: input.runsOn } : {}),
  ...(input.agent ? { agent: input.agent } : {}),
  ...(input.project ? { project: input.project } : {}),
  ...(input.inline?.length ? { inlinePicks: input.inline } : {}),
})

/** An SSE echo proves storage even if the HTTP response never reaches this browser. */
async function confirmedSend<T extends ChatMessage>(qc: QueryClient, key: readonly unknown[], id: string, send: () => Promise<T>): Promise<T> {
  try { return await send() }
  catch (err) {
    const stored = qc.getQueryData<T[]>(key)?.find((m) => m.id === id && !m.meta?.pending)
    if (stored) return stored
    throw err
  }
}

export function useSendChat() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: ChatSend) => confirmedSend(qc, keys.chat, input.id, () => api<ChatMessage>("/api/chat", { body: sendBody(input) })),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: keys.chat })
      const undo = () => qc.setQueryData<ChatMessage[]>(keys.chat, (list) => list?.filter((m) => m.id !== input.id || !m.meta?.pending))
      // Mid-turn it shows as queued right away; the server's answer says for sure.
      const queued = Boolean(qc.getQueryData<boolean>(keys.chatBusy) ?? qc.getQueryData<OrchestratorState>(keys.orchestrator)?.busy)
      qc.setQueryData<ChatMessage[]>(keys.chat, (list) =>
        upsert(list, {
          id: input.id,
          role: "user",
          content: input.content,
          meta: { pending: true, ...(input.attachments?.length ? { attachments: input.attachments } : {}), ...pickMeta(input), ...(queued ? { queued: true } : {}) },
          createdAt: Date.now(),
        }),
      )
      return { undo }
    },
    onError: (err, _v, ctx) => {
      ctx?.undo()
      playSendSound("failed")
      fail("Couldn't send to the Coordinator")(err)
    },
    onSuccess: (msg) => {
      playSendSound()
      const list = qc.setQueryData<ChatMessage[]>(keys.chat, (list) => settleOptimistic(list, msg))
      liveMessage(keys.chat, list!.find((m) => m.id === msg.id)!)
    },
  })
}

export function useSendCaptainMessage(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: ChatSend & { projectId?: string }) => confirmedSend(qc, keys.captainMessages(input.projectId ?? projectId), input.id, () => api<CaptainMessage>(`/api/projects/${input.projectId ?? projectId}/captain/messages`, { body: sendBody(input) })),
    onMutate: async (input) => {
      const destinationId = input.projectId ?? projectId
      await qc.cancelQueries({ queryKey: keys.captainMessages(destinationId) })
      const undo = () => qc.setQueryData<CaptainMessage[]>(keys.captainMessages(destinationId), (list) => list?.filter((m) => m.id !== input.id || !m.meta?.pending))
      const queued = Boolean(qc.getQueryData<CaptainState>(keys.captain(destinationId))?.busy)
      qc.setQueryData<CaptainMessage[]>(keys.captainMessages(destinationId), (list) =>
        upsert(list, {
          id: input.id,
          projectId: destinationId,
          role: "user",
          content: input.content,
          meta: { pending: true, source: "cody", ...(input.attachments?.length ? { attachments: input.attachments } : {}), ...pickMeta(input), ...(queued ? { queued: true } : {}) },
          createdAt: Date.now(),
        }),
      )
      return { undo }
    },
    onError: (err, _v, ctx) => {
      ctx?.undo()
      playSendSound("failed")
      fail("Couldn't message the Captain")(err)
    },
    onSuccess: (msg, input) => {
      const destinationId = input.projectId ?? projectId
      playSendSound()
      const list = qc.setQueryData<CaptainMessage[]>(keys.captainMessages(destinationId), (list) => settleOptimistic(list, msg))
      liveMessage(keys.captainMessages(destinationId), list!.find((m) => m.id === msg.id)!)
    },
    // Sending cancelled the history still loading in above a prefetched tail: load it again.
    onSettled: (_data, _err, input) => {
      const destinationId = input.projectId ?? projectId
      if (captainTails.has(destinationId)) void qc.invalidateQueries({ queryKey: keys.captainMessages(destinationId) })
    },
  })
}

/**
 * Stop the Coordinator's running turn, or (`projectId`) that project's Captain's: Orchestrator/Captain.stopTurn.
 * The chat shows idle from the click; the server says so to every open chat too, and busy again if a queued message's
 * turn follows. When nothing was stopped (it had just ended, or is compacting), the server's state comes back.
 */
export function useStopChatTurn(projectId: string | null) {
  const qc = useQueryClient()
  const busyKey = projectId ? keys.captain(projectId) : keys.chatBusy
  const settle = () => void qc.invalidateQueries({ queryKey: busyKey })
  return useMutation({
    mutationFn: () => api<{ ok: boolean; stopped: boolean }>(projectId ? `/api/projects/${projectId}/captain/stop` : "/api/chat/stop", { method: "POST" }),
    onMutate: () => {
      void qc.cancelQueries({ queryKey: busyKey })
      if (projectId) qc.setQueryData<CaptainState>(busyKey, (s) => s && { ...s, busy: false })
      else {
        // As the server's chat.busy does (lib/stream.ts): the stopped turn's streamed text goes with it.
        qc.setQueryData(busyKey, false)
        qc.setQueryData(keys.chatStream, "")
      }
    },
    onSuccess: (r) => !r.stopped && settle(),
    onError: (err) => {
      settle()
      fail(projectId ? "Couldn't stop the Captain" : "Couldn't stop the Coordinator")(err)
    },
  })
}

/**
 * The message box's Stop (Composer `stop`) for the Coordinator's chat (`projectId` null) or a Captain's: while its turn
 * runs, but not while it compacts (a compaction finishes). `busy` is the chat's own busy flag.
 */
export function useChatTurnStop(projectId: string | null, busy: boolean) {
  const { mutate } = useStopChatTurn(projectId)
  const coordinator = useQuery({ queryKey: keys.orchestrator, queryFn: ({ client }) => fetchLiveState(client, keys.orchestrator, () => api<OrchestratorState>("/api/orchestrator")), staleTime: Infinity, enabled: busy && !projectId, select: isCompacting })
  const captain = useQuery({
    queryKey: keys.captain(projectId ?? ""),
    queryFn: ({ client }) => fetchLiveState(client, keys.captain(projectId ?? ""), () => api<CaptainState>(`/api/projects/${projectId}/captain`)),
    staleTime: Infinity,
    enabled: busy && projectId !== null,
    select: isCompacting,
  })
  const compacting = Boolean(projectId ? captain.data : coordinator.data)
  return useMemo(
    () => (busy && !compacting ? { label: projectId ? "Stop the Captain's turn" : "Stop the Coordinator's turn", onStop: () => mutate() } : null),
    [busy, compacting, projectId, mutate],
  )
}
const isCompacting = (s: { compacting: boolean }) => s.compacting

export const newClientId = clientId

export function useSaveSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: Partial<Settings>) => api<SettingsInfo>("/api/agent-settings", { method: "PUT", body: patch }),
    onSuccess: (info) => qc.setQueryData(keys.agentSettings, info),
    onError: fail("Couldn't save the settings"),
  })
}

export function useResetSettings() {
  const qc = useQueryClient()
  return useMutation({
    /** No keys: forget every saved value. Keys: forget only those, so env vars or defaults apply to them again. */
    mutationFn: (keys?: (keyof Settings)[]) =>
      api<SettingsInfo>(keys ? `/api/agent-settings?keys=${keys.map(encodeURIComponent).join(",")}` : "/api/agent-settings", { method: "DELETE" }),
    onSuccess: (info) => qc.setQueryData(keys.agentSettings, info),
    onError: fail("Couldn't reset the settings"),
  })
}

export function useCompactTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (taskId: string) => api<Task>(`/api/tasks/${taskId}/compact`, { method: "POST", body: {} }),
    onMutate: (taskId) => patchTask(qc, taskId, { compactPending: true }),
    onSuccess: (task) => qc.setQueryData<Task[]>(keys.tasks, (list) => (list ? upsert(list, task) : list)),
    onError: (err, taskId) => {
      patchTask(qc, taskId, { compactPending: false })
      toast.error("Couldn't compact", err.message)
    },
  })
}

export function useCompactOrchestrator() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api<OrchestratorState>("/api/orchestrator/compact", { method: "POST", body: {} }),
    onSuccess: (state) => qc.setQueryData(keys.orchestrator, state),
    onError: fail("Couldn't compact"),
  })
}

export function useCompactCaptain(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api<CaptainState>(`/api/projects/${projectId}/captain/compact`, { method: "POST", body: {} }),
    onSuccess: (state) => qc.setQueryData(keys.captain(projectId), state),
    onError: fail("Couldn't compact the Captain"),
  })
}
