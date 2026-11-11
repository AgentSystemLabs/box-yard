import { useEffect, useState } from "react"
import { notifyManager, useQueryClient } from "@tanstack/react-query"
import { forgetCaptainTail, keys, upsert } from "./queries"
import { applyRead, receiveNotification } from "./notifications"
import { withActivity } from "./taskSummary"
import { applyOrder } from "./projectOrder"
import { announceCleanup, withCleanup } from "./diskCleanup"
import { announceResize, withResize } from "./boxResize"
import { announceSnapshot } from "./projectSnapshot"
import { placeMessage } from "./queued"
import { placeTaskMessage, submissionId, taskSubmissionWait } from "./taskSubmissions"
import { voiceCaptainMessage, voiceChatBusy, voiceChatMessage, voiceChatTurn } from "./speech"
import { loadTtsInfo, setTtsInfo } from "./tts"
import { onResume } from "./resume"
import { reportOnline, reportStream, setReconnectHandler } from "./connection"
import { applyThreadEvent } from "./threads"
import { staleAfterClose } from "./closedTasks"
import { staleAfterStop } from "./stoppedTasks"
import { liveMessage, liveState } from "./liveQueries"
import { afterBoot, alignWithBoot, takeEarlyStream } from "./boot"
import { noteServerBuild } from "./appUpdate"
import { applyTaskPatch, type TaskPatchEvent } from "../../../shared/taskPatch"
import type { AppNotification, Artifact, BoxInfo, CaptainMessage, ChatMessage, Project, Schedule, ScheduleRun, Task, TaskMessage, QueuedMessage, UiEvent } from "../../../shared/types"
import type { StreamHello } from "../../../shared/boot"
import type { RunPodStatus } from "../../../shared/runpod"
import type { DockerStatus } from "../../../shared/docker"

export type Connection = "connecting" | "live" | "offline"

/** Back after this long away, the stream is reopened even if it says it's open: iOS leaves dead ones that never error. */
export const STALE_STREAM_MS = 30_000
/** A batch waiting for a frame is applied after this long anyway (frames can stop coming, e.g. a page iOS just thawed). */
const FLUSH_FALLBACK_MS = 250
/**
 * Task and box events refresh the usage queries (the Usage modal's ledger and limits) at most this often, the last
 * one included: a busy yard sends several a second, and each refresh rebuilds today's spend on the server.
 */
export const USAGE_REFRESH_MS = 5_000

/**
 * Subscribe to server events and write them straight into the TanStack Query
 * cache, so every view updates live without refetching. Events are applied in
 * batches, once per frame, so a burst (streamed text, many task updates) costs
 * one render instead of one per event.
 */
export function useServerEvents(enabled: boolean): Connection {
  const qc = useQueryClient()
  const [state, setState] = useState<Connection>("connecting")

  useEffect(() => {
    if (!enabled) return
    let es: EventSource | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let wasOffline = false
    let closed = false
    let queue: UiEvent[] = []
    let scheduled = false
    let frame = 0
    let fallback: ReturnType<typeof setTimeout> | null = null
    let usageTimer: ReturnType<typeof setTimeout> | null = null
    let usageAt = -Infinity
    const refreshUsage = () => {
      if (usageTimer) return
      usageTimer = setTimeout(
        () => {
          usageTimer = null
          usageAt = Date.now()
          void qc.invalidateQueries({ queryKey: keys.usage })
        },
        Math.max(0, usageAt + USAGE_REFRESH_MS - Date.now()),
      )
    }
    // The composers read it too (lib/connection.ts): "Reconnecting…", and sends held until it's live.
    const set = (next: Connection) => {
      setState(next)
      reportStream(next === "live")
    }
    // Each task as this connection last sent it: after the first time, an update is a patch of what changed.
    const streamed = new Map<string, Task>()

    const flush = () => {
      if (!scheduled) return
      scheduled = false
      cancelAnimationFrame(frame)
      if (fallback) clearTimeout(fallback)
      fallback = null
      const events = queue
      queue = []
      notifyManager.batch(() => {
        for (let i = 0; i < events.length; i++) {
          const ev = events[i]!
          // Join a run of streamed chunks into one cache write.
          if (ev.type === "chat.delta") {
            let text = ev.text
            while (events[i + 1]?.type === "chat.delta") text += (events[++i] as { text: string }).text
            apply({ type: "chat.delta", text })
          } else if (ev.type === "thread.delta") {
            let text = ev.text
            while (events[i + 1]?.type === "thread.delta" && (events[i + 1] as { threadId: string }).threadId === ev.threadId) text += (events[++i] as { text: string }).text
            apply({ ...ev, text })
          } else apply(ev)
        }
      })
    }
    const enqueue = (ev: UiEvent) => {
      queue.push(ev)
      if (scheduled) return
      scheduled = true
      // Background tabs get no animation frames; still apply events, just less often. Whichever comes first wins.
      if (!document.hidden) frame = requestAnimationFrame(flush)
      fallback = setTimeout(flush, FLUSH_FALLBACK_MS)
    }

    const serverBuild = (e: MessageEvent) => {
      try {
        noteServerBuild((JSON.parse(e.data) as StreamHello).web)
      } catch {}
    }

    let first = true
    const connect = () => {
      // The first connection: the stream the page opened as it loaded (lib/boot.ts), lined up with the snapshot the
      // app opened with, so no event is missed or applied twice.
      const early = first ? takeEarlyStream() : null
      const align = first ? alignWithBoot(() => void qc.invalidateQueries()) : null
      first = false
      const source = early?.es ?? new EventSource("/api/stream?patches=1")
      es = source
      const opened = () => {
        // A new connection sends each task whole again before patching it.
        streamed.clear()
        set("live")
        // Which voice to speak with lives on the server (Settings › Voice).
        void loadTtsInfo(true)
        // Anything could have changed while we were away.
        if (wasOffline) void qc.invalidateQueries()
        wasOffline = false
      }
      source.onopen = opened
      source.onerror = () => {
        set("offline")
        wasOffline = true
        es?.close()
        if (!closed) retry = setTimeout(connect, 2000)
      }
      source.onmessage = (e) => {
        let ev: UiEvent | TaskPatchEvent
        try {
          ev = JSON.parse(e.data)
        } catch {
          return
        }
        // One the snapshot already includes still moves the task a later patch applies to.
        const fresh = !align || align.keep()
        if (ev.type === "task.patch") {
          const base = streamed.get(ev.id)
          // The server sends a task whole first, so this can't happen; if it does, the list is reloaded.
          if (!base) return void qc.invalidateQueries({ queryKey: keys.tasks })
          ev = { type: "task", task: applyTaskPatch(base, ev) }
        }
        if (ev.type === "task") streamed.set(ev.task.id, ev.task)
        else if (ev.type === "task.deleted") streamed.delete(ev.taskId)
        if (fresh) enqueue(ev)
      }
      // Which build the server serves now: after a restart onto a newer one, this page reloads (lib/appUpdate.ts).
      source.addEventListener("hello", serverBuild)
      if (align) {
        source.addEventListener("hello", align.hello)
        source.addEventListener("boot", align.mark)
      }
      if (early) {
        if (source.readyState === EventSource.OPEN) opened()
        early.replay()
      }
    }

    const apply = (ev: UiEvent) => {
      if (applyThreadEvent(qc, ev)) return
      switch (ev.type) {
        case "task":
          // Sent before a close this browser made, and late: the task stays done. Still the turn a Stop here is
          // ending: it stays stopped.
          if (staleAfterClose(ev.task) || staleAfterStop(ev.task)) break
          qc.setQueryData<Task[]>(keys.tasks, (list) => (list ? upsert(list, ev.task) : list))
          refreshUsage()
          taskSubmissionWait(qc, ev.task)
          break
        case "task.deleted":
          qc.setQueryData<Task[]>(keys.tasks, (list) => list?.filter((t) => t.id !== ev.taskId))
          qc.setQueryData<AppNotification[]>(keys.notifications, (list) => list?.filter((n) => n.taskId !== ev.taskId))
          refreshUsage()
          break
        case "task.message":
          liveMessage(keys.taskMessages(ev.message.taskId), ev.message)
          qc.setQueryData<TaskMessage[]>(keys.taskMessages(ev.message.taskId), (list) => {
            if (!list) return list
            if (ev.message.meta?.clientMessageId) return placeTaskMessage(list, ev.message)
            // An update (a queued message delivered) may move it.
            if (list.some((m) => m.id === ev.message.id)) return placeMessage(list, ev.message)
            // Replace the optimistic copy of a message we sent.
            const tmp = list.findIndex((m) => m.id.startsWith("tmp-") && m.role === ev.message.role && m.content === ev.message.content)
            if (tmp >= 0) {
              const next = list.slice()
              next[tmp] = ev.message
              return next
            }
            return [...list, ev.message]
          })
          if (ev.message.meta?.clientMessageId) qc.setQueryData<QueuedMessage[]>(keys.taskQueue(ev.message.taskId), (list) => list?.filter((m) => m.clientMessageId !== submissionId(ev.message) || (ev.message.meta?.steerAccepted === true && !m.id.startsWith("tmp-"))))
          // Cards of tasks without a summary yet show the latest activity line.
          qc.setQueryData<Task[]>(keys.tasks, (list) => withActivity(list, ev.message))
          break
        case "project":
          qc.setQueryData<Project[]>(keys.projects, (list) => (list ? upsert(list, ev.project) : list))
          break
        case "limits":
          void qc.invalidateQueries({ queryKey: keys.limits })
          break
        case "identities":
          qc.setQueryData(keys.identities, ev.identities)
          void qc.invalidateQueries({ queryKey: ["run-targets"] })
          void qc.invalidateQueries({ queryKey: ["harness-targets"] })
          break
        case "connectors":
          qc.setQueryData(keys.connectors, ev.connectors)
          break
        case "machines":
          qc.setQueryData(keys.machines, ev.status)
          void qc.invalidateQueries({ queryKey: ["run-targets"] })
          void qc.invalidateQueries({ queryKey: ["harness-targets"] })
          break
        case "projects.order":
          qc.setQueryData<Project[]>(keys.projects, (list) => (list ? applyOrder(list, ev.ids) : list))
          break
        case "project.deleted":
          qc.setQueryData<Project[]>(keys.projects, (list) => list?.filter((p) => p.id !== ev.projectId))
          qc.setQueryData<Schedule[]>(keys.schedules, (list) => list?.filter((s) => s.projectId !== ev.projectId))
          // Its Captain was kept in memory (lib/captainPrefetch.ts).
          qc.removeQueries({ queryKey: keys.captainMessages(ev.projectId) })
          qc.removeQueries({ queryKey: keys.captain(ev.projectId) })
          forgetCaptainTail(ev.projectId)
          break
        case "chat.message":
          liveMessage(keys.chat, ev.message)
          qc.setQueryData<ChatMessage[]>(keys.chat, (list) => (list ? placeMessage(list, ev.message) : list))
          if (ev.message.role === "assistant" || ev.message.role === "tool") qc.setQueryData(keys.chatStream, "")
          voiceChatMessage(ev.message)
          break
        case "chat.turn":
          voiceChatTurn(ev)
          break
        case "chat.delta":
          qc.setQueryData<string>(keys.chatStream, (prev) => (prev ?? "") + ev.text)
          break
        case "chat.busy":
          liveState(qc, keys.chatBusy, ev.busy)
          if (!ev.busy) qc.setQueryData(keys.chatStream, "")
          voiceChatBusy(ev.busy)
          break
        case "orchestrator.state":
          liveState(qc, keys.orchestrator, ev.state)
          break
        case "captain.message":
          liveMessage(keys.captainMessages(ev.message.projectId), ev.message)
          voiceCaptainMessage(ev.message)
          qc.setQueryData<CaptainMessage[]>(keys.captainMessages(ev.message.projectId), (list) => {
            if (!list) return list
            if (list.some((m) => m.id === ev.message.id)) return placeMessage(list, ev.message)
            const tmp = list.findIndex((m) => m.id.startsWith("tmp-") && m.role === ev.message.role && m.content === ev.message.content)
            if (tmp >= 0) {
              const next = list.slice()
              next[tmp] = ev.message
              return next
            }
            return [...list, ev.message]
          })
          break
        case "captain.state":
          liveState(qc, keys.captain(ev.state.projectId), ev.state)
          break
        case "logins":
          qc.setQueryData(keys.logins, ev.logins)
          break
        case "setup":
          qc.setQueryData(keys.setup, ev.status)
          void qc.invalidateQueries({ queryKey: keys.health })
          void qc.invalidateQueries({ queryKey: keys.setupRepos })
          break
        case "runpod.build":
          qc.setQueryData<RunPodStatus>(keys.runpod, (old) => (old ? { ...old, build: ev.build } : old))
          break
        case "update":
          qc.setQueryData(keys.update, ev.status)
          break
        case "docker.build":
          qc.setQueryData<DockerStatus>(keys.docker, (old) =>
            old ? { ...old, build: ev.build, image: ev.build.state === "succeeded" && ev.build.image === old.image.tag ? { ...old.image, present: true } : old.image } : old,
          )
          break
        case "tts":
          setTtsInfo(ev.info)
          qc.setQueryData(keys.tts, ev.info)
          break
        case "settings":
          qc.setQueryData(keys.agentSettings, ev.info)
          void qc.invalidateQueries({ queryKey: ["run-targets"] })
          void qc.invalidateQueries({ queryKey: ["harness-targets"] })
          void qc.invalidateQueries({ queryKey: keys.health })
          // The setup card shows the owner's name.
          void qc.invalidateQueries({ queryKey: keys.setup })
          void qc.invalidateQueries({ queryKey: keys.usage })
          break
        case "artifact":
          qc.setQueryData<Artifact[]>(keys.artifacts, (list) => (list ? upsert(list, ev.artifact, true) : list))
          break
        case "boxes":
          qc.setQueryData(keys.boxes, ev.boxes)
          refreshUsage()
          break
        case "box.cleanup":
          qc.setQueryData<BoxInfo[]>(keys.boxes, (list) => withCleanup(list, ev.cleanup))
          announceCleanup(ev.cleanup)
          break
        case "box.resize":
          qc.setQueryData<BoxInfo[]>(keys.boxes, (list) => withResize(list, ev.resize))
          announceResize(ev.resize)
          break
        case "project.snapshot": {
          const job = ev.job
          void qc.invalidateQueries({ queryKey: keys.boxes })
          announceSnapshot(job, qc.getQueryData<Project[]>(keys.projects)?.find((p) => p.id === job.projectId)?.name)
          break
        }
        case "schedule":
          qc.setQueryData<Schedule[]>(keys.schedules, (list) => (list ? upsert(list, ev.schedule) : list))
          break
        case "schedule.run":
          qc.setQueryData<ScheduleRun[]>(keys.scheduleRuns, (list) => (list ? upsert(list, ev.run, true) : list))
          break
        case "notification":
          receiveNotification(qc, ev.notification)
          break
        case "notifications.read":
          qc.setQueryData<AppNotification[]>(keys.notifications, (list) => applyRead(list, ev.ids, ev.readAt))
          break
        case "schedule.deleted":
          qc.setQueryData<Schedule[]>(keys.schedules, (list) => list?.filter((s) => s.id !== ev.scheduleId))
          break
        case "hook":
        case "hook.deleted":
          void qc.invalidateQueries({ queryKey: ["hooks"] })
          break
        case "hook.run":
          // The run log, and each hook's "last run" line.
          void qc.invalidateQueries({ queryKey: ["hook-runs"] })
          void qc.invalidateQueries({ queryKey: ["hooks"] })
          break
      }
    }

    // A new stream now (and everything refetched once it opens), instead of at the next retry.
    const reopen = () => {
      // None yet: the first opens once the boot data is in.
      if (!es) return
      es.close()
      if (retry) clearTimeout(retry)
      retry = null
      wasOffline = true
      set("connecting")
      connect()
    }
    // Back from the background: a stream that isn't open, or one that sat frozen a while, is replaced now
    // (and everything refetched) instead of waiting for an error that may never come.
    const offResume = onResume((away) => {
      if (closed || !es) return
      if (es.readyState === EventSource.OPEN && away < STALE_STREAM_MS) return
      reopen()
    })
    // The composers' Retry.
    const offRetry = setReconnectHandler(() => {
      if (!closed) reopen()
    })
    // The network changed under the stream: a phone's old connection can hang without an error, so a new one says at
    // once whether Box Yard is reachable (on this computer, with the Wi-Fi off, it simply opens again).
    const onNetwork = () => {
      reportOnline(navigator.onLine !== false)
      if (!closed) reopen()
    }
    window.addEventListener("online", onNetwork)
    window.addEventListener("offline", onNetwork)

    // Events wait for the boot data they update.
    afterBoot(() => {
      if (!closed) connect()
    })
    return () => {
      closed = true
      queue = []
      offResume()
      offRetry()
      window.removeEventListener("online", onNetwork)
      window.removeEventListener("offline", onNetwork)
      if (retry) clearTimeout(retry)
      if (fallback) clearTimeout(fallback)
      if (usageTimer) clearTimeout(usageTimer)
      cancelAnimationFrame(frame)
      es?.close()
    }
  }, [enabled, qc])

  return state
}
