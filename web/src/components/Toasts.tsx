import type { MouseEvent } from "react"
import { Loader2, X } from "lucide-react"
import { dismiss, pauseToasts, resumeToasts, showsWhenQuiet, useToasts, type Toast, type ToastTone } from "../lib/toast"
import { followAppLink } from "../lib/linkify"
import { navigateApp, appHref } from "../lib/navigation"
import { STATUS, StatusBadge, TAP_AREA, cx } from "./ui"

const TONE: Record<ToastTone, string> = {
  neutral: "border-l-zinc-500",
  red: "border-l-red-500",
  amber: "border-l-amber-400",
  green: "border-l-emerald-400",
}

/**
 * Every toast is the stack's width, whatever its text: 25rem, never wider than the window less a 1rem margin each side,
 * and the whole width on a phone. Long text wraps and the toast grows taller.
 */
const STACK_WIDTH = "w-[25rem] max-w-[calc(100%-2rem)] max-[30rem]:w-auto max-[30rem]:max-w-none"

/**
 * The one toast stack, bottom right of the main pane. Only this component subscribes to the toast store,
 * so a toast coming or going re-renders nothing else. Hovering the stack holds every toast.
 * `quiet` (App.tsx) shows only critical toasts and Undo ones (showsWhenQuiet), top right below the chat header, clear of
 * the composer. Screen readers hear every toast, shown or not (SpokenToasts).
 */
export function Toasts({ className, quiet = false }: { className?: string; quiet?: boolean }) {
  const all = useToasts()
  const toasts = quiet ? all.filter(showsWhenQuiet) : all
  return (
    <>
      <SpokenToasts toasts={all} />
      {toasts.length > 0 && (
        <div
          onMouseEnter={pauseToasts}
          onMouseLeave={resumeToasts}
          data-quiet={quiet || undefined}
          className={cx(
            "pointer-events-none z-50 flex flex-col gap-2",
            STACK_WIDTH,
            quiet
              ? "fixed top-[calc(env(safe-area-inset-top)+4.5rem)] right-[max(1rem,env(safe-area-inset-right))] max-[30rem]:left-[max(1rem,env(safe-area-inset-left))]"
              : "absolute right-4 bottom-4 max-[30rem]:left-4",
            className,
          )}
        >
          {toasts.map((t) => (t.kind === "task" ? <TaskToast key={t.id} t={t} /> : <PlainToast key={t.id} t={t} />))}
        </div>
      )}
    </>
  )
}

/** A toast in words: its title, the task's state, the project (or a batch's breakdown) and the line under it. */
export function spokenToast(t: Toast) {
  return [t.title, t.status && STATUS[t.status].label, t.context, t.body].filter(Boolean).join(". ")
}

/**
 * Every toast in words, for screen readers, in live regions that are always in the page: one that appears along with
 * its text is often not read. It speaks the toasts `quiet` keeps off screen too, so a task that needs Cody, opened a PR
 * or finished is heard, not only seen in the sidebar. Errors interrupt; the rest wait their turn.
 */
function SpokenToasts({ toasts }: { toasts: readonly Toast[] }) {
  const line = (t: Toast) => <p key={t.id}>{spokenToast(t)}</p>
  return (
    <div className="sr-only" data-testid="spoken-toasts">
      <div aria-live="polite">{toasts.filter((t) => t.kind !== "error").map(line)}</div>
      <div aria-live="assertive">{toasts.filter((t) => t.kind === "error").map(line)}</div>
    </div>
  )
}

function TaskToast({ t }: { t: Toast }) {
  const open = (e: MouseEvent<HTMLAnchorElement>) => {
    // Plain click: navigate in place (a task opens in the side panel). Cmd/Ctrl/middle click: the browser opens a new tab.
    followAppLink(e, t.href!, navigateApp)
    t.onOpen?.()
    dismiss(t.id)
  }
  return (
    <div
      data-toast="task"
      className={cx(
        "pointer-events-auto relative w-full overflow-hidden rounded-lg border border-l-4 border-zinc-800 bg-zinc-900 text-sm text-zinc-100 shadow-xl transition hover:bg-zinc-800/80",
        TONE[t.tone ?? "neutral"],
      )}
    >
      <a href={appHref(t.href!, location.origin) ?? "/"} onClick={open} onAuxClick={(e) => e.button === 1 && open(e)} className="block py-2.5 pr-12 pl-3 focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none focus-visible:ring-inset">
        <div className="font-medium wrap-anywhere">{t.title}</div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-400">
          {t.status && <StatusBadge status={t.status} />}
          {t.context && <span className="min-w-0 wrap-anywhere">{t.context}</span>}
        </div>
        {t.body && <div className="mt-1 text-xs text-zinc-400 wrap-anywhere">{t.body}</div>}
      </a>
      <DismissToast id={t.id} className="absolute top-0 right-0" />
    </div>
  )
}

/** A click dismisses it, except one with an action (Undo): a tap just beside the button mustn't throw the Undo away. */
function PlainToast({ t }: { t: Toast }) {
  const error = t.kind === "error"
  return (
    <div
      data-toast={t.kind}
      onClick={t.action ? undefined : () => dismiss(t.id)}
      className={cx(
        "pointer-events-auto flex w-full items-start gap-1.5 rounded-lg border py-1.5 pr-1.5 pl-4 text-sm shadow-xl",
        !t.action && "cursor-pointer",
        error ? "border-red-900 bg-red-950 text-red-100" : "border-zinc-800 bg-zinc-900 text-zinc-100",
      )}
    >
      {t.progress && <Loader2 className="mt-1.5 h-4 w-4 shrink-0 animate-spin text-sky-300" aria-hidden />}
      <div className="min-w-0 flex-1 py-1">
        <div className="font-medium wrap-anywhere">{t.title}</div>
        {t.body && <div className="mt-0.5 text-xs opacity-80 wrap-anywhere">{t.body}</div>}
      </div>
      {t.action && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            t.action!.onClick()
            dismiss(t.id)
          }}
          className={cx(
            TAP_AREA,
            "h-8 shrink-0 rounded-md px-3 text-xs font-semibold text-yard-400 hover:bg-zinc-800 hover:text-yard-300 focus-visible:ring-2 focus-visible:ring-yard-500 focus-visible:outline-none",
          )}
        >
          {t.action.label}
        </button>
      )}
      <DismissToast id={t.id} error={error} className="-m-1.5" />
    </div>
  )
}

/**
 * Every toast's ✕, top right: a 44px target drawn as a 32px chip (its ring shows on keyboard focus). It only dismisses:
 * never the toast's action (Undo) or its link.
 */
function DismissToast({ id, error = false, className }: { id: number; error?: boolean; className?: string }) {
  return (
    <button
      type="button"
      aria-label="Dismiss"
      title="Dismiss"
      onClick={(e) => {
        e.stopPropagation()
        dismiss(id)
      }}
      className={cx("group grid h-11 w-11 shrink-0 place-items-center rounded-lg focus-visible:outline-none", className)}
    >
      <span
        className={cx(
          "grid h-8 w-8 place-items-center rounded-lg group-focus-visible:ring-2 group-focus-visible:ring-yard-500",
          error ? "text-red-300 group-hover:bg-red-900 group-hover:text-red-100" : "text-zinc-400 group-hover:bg-zinc-800 group-hover:text-zinc-100",
        )}
      >
        <X className="h-4 w-4" aria-hidden />
      </span>
    </button>
  )
}
