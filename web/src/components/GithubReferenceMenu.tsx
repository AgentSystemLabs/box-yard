import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from "react"
import { createPortal, flushSync } from "react-dom"
import { useQuery } from "@tanstack/react-query"
import { CircleCheck, CircleDot } from "lucide-react"
import type { GithubReference, GithubReferenceAnswer } from "../../../shared/githubReferences"
import type { Project } from "../../../shared/types"
import { api } from "../lib/api"
import { githubMentionAt, insertGithubReference } from "../lib/githubReferences"
import { keys } from "../lib/queries"
import { pickerKeyDown } from "../lib/pickerKeys"
import { useAbove } from "../lib/useAbove"
import { Loading } from "./Loading"
import { cx, PR_STYLE, TAP_AREA } from "./ui"

export function useGithubReferences({ projectId, draftKey, value, setValue, input, blocked }: {
  projectId: string | null
  draftKey: string
  value: string
  setValue: (value: string) => void
  input: RefObject<HTMLTextAreaElement | null>
  blocked: boolean
}) {
  const [focused, setFocused] = useState(false)
  const [caret, setCaret] = useState(0)
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const id = `${useId()}-github`
  const mention = value.includes("#") ? githubMentionAt(value, Math.min(caret, value.length)) : null
  const scope = JSON.stringify([draftKey, projectId, mention?.start])
  const open = Boolean(focused && !blocked && mention && scope !== dismissed)
  const q = mention?.query ?? ""
  // Scope changes hide previous options immediately; each filter waits for a quiet 250 ms before requesting it.
  const request = JSON.stringify([projectId, q])
  const [settled, setSettled] = useState<string | null>(null)
  useEffect(() => {
    if (!open || !projectId) return
    const timer = setTimeout(() => setSettled(request), 250)
    return () => clearTimeout(timer)
  }, [open, projectId, request])
  const selectScope = useCallback((projects: Project[]) => {
    const p = projects.find((p) => p.id === projectId)
    return p ? `${p.repo ?? ""}:${p.identityId}` : ""
  }, [projectId])
  const projectScope = useQuery({ queryKey: keys.projects, queryFn: () => api<Project[]>("/api/projects"), enabled: open && Boolean(projectId), select: selectScope }).data
  const query = useQuery({
    queryKey: ["github-references", projectId, projectScope, q],
    queryFn: ({ signal }) => api<GithubReferenceAnswer>(`/api/projects/${encodeURIComponent(projectId!)}/github-references?q=${encodeURIComponent(q)}`, { signal }),
    enabled: open && Boolean(projectId) && settled === request,
    staleTime: (query) => query.state.data?.problem ? 0 : 30_000,
    gcTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  })
  const data = projectId && settled === request ? query.data : undefined
  const items = data?.items ?? []
  const loading = Boolean(projectId && (settled !== request || query.isPending))
  const problem = !projectId ? "Choose a project with % in the Coordinator chat to look up its GitHub issues and pull requests."
    : query.error ? "Couldn't load GitHub references."
    : data?.problem ?? null
  useEffect(() => setActive(0), [request, projectScope, data])
  useEffect(() => {
    if (!mention || scope !== dismissed) setDismissed(null)
  }, [scope, dismissed, Boolean(mention)])
  const caretRef = useRef(0)
  const onCaret = useCallback(() => {
    const el = input.current
    const next = el && el.selectionStart === el.selectionEnd ? el.selectionStart : -1
    if (next !== caretRef.current) {
      caretRef.current = next
      setCaret(next)
    }
  }, [input])
  const pick = (ref: GithubReference) => {
    const el = input.current
    const current = el ? githubMentionAt(el.value, el.selectionStart) : null
    // Recheck against the current input, including context switches while a response was in flight.
    if (!el || !current || !data?.repo || current.start !== mention?.start || current.query !== q) return
    const next = insertGithubReference(el.value, current, ref, data.repo)
    flushSync(() => setValue(next.value))
    el.focus()
    el.setSelectionRange(next.caret, next.caret)
    onCaret()
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => open && pickerKeyDown(e, {
    options: items, active, setActive, disabled: () => loading, pick, escape: () => setDismissed(scope),
  })
  return {
    open, id, items, active, setActive, loading, problem, repo: data?.repo, pick,
    retryable: Boolean(projectId && (query.error || data?.repo)),
    retry: () => void query.refetch(), onCaret, onFocus: setFocused, onKeyDown,
    inputProps: open ? {
      role: "combobox", "aria-autocomplete": "list" as const, "aria-haspopup": "listbox" as const,
      "aria-expanded": true, "aria-controls": id,
      "aria-activedescendant": items[active] ? `${id}-${active}` : undefined,
    } : {},
  }
}

/** Same portal, caret focus, listbox semantics and pointer selection as the Composer's run-target list. */
export function GithubReferenceMenu({ picker, anchor }: { picker: ReturnType<typeof useGithubReferences>; anchor: RefObject<HTMLElement | null> }) {
  const at = useAbove(anchor)
  const { id, active, items, loading, problem, repo } = picker
  useEffect(() => {
    document.getElementById(`${id}-${active}`)?.scrollIntoView?.({ block: "nearest" })
  }, [id, active, items])
  if (!at) return null
  return createPortal(
    <div data-testid="github-reference-menu" style={{ left: at.left, width: at.width, bottom: at.bottom }}
      className="fixed z-50 flex flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 shadow-xl shadow-black/40"
      onMouseDown={(e) => e.preventDefault()}>
      <div className="min-h-11 border-b border-zinc-800/80 px-3 py-2 text-xs text-zinc-300">
        GitHub issues and pull requests
        <span className="block truncate text-[11px] text-zinc-500">
          {repo ?? "Current project's repository"} · type a number or title
          {/* The keys are for a keyboard: a phone taps a row. */}
          <span className="pointer-coarse:hidden"> · ↑↓ choose · Enter/Tab insert · Esc close</span>
        </span>
      </div>
      {loading && <Loading kind="rows" label="Searching GitHub" />}
      {!loading && problem && <div role="status" className="flex items-center gap-3 px-3 py-2 text-xs text-amber-300 pointer-coarse:min-h-11">
        <span className="min-w-0 flex-1">{problem}</span>
        {picker.retryable && <button type="button" className={cx(TAP_AREA, "shrink-0 rounded-sm underline underline-offset-2 hover:text-amber-200")} onClick={picker.retry}>Try again</button>}
      </div>}
      {!loading && !problem && !items.length && <div role="status" className="px-3 py-2 text-xs text-zinc-500">No matching issues or pull requests.</div>}
      <ul id={id} role="listbox" aria-label="GitHub issues and pull requests" aria-busy={loading || undefined}
        style={{ maxHeight: at.maxHeight - 64 }} className="scroll-thin overflow-y-auto overscroll-contain py-1">
        {items.map((item, i) => {
          // GitHub's own glyphs and colours (PrChip's): open green, merged purple, closed red; an issue closes purple.
          const Icon = item.kind === "pull" ? PR_STYLE[item.state].icon : item.state === "open" ? CircleDot : CircleCheck
          const tone = PR_STYLE[item.kind === "issue" && item.state === "closed" ? "merged" : item.state].link
          return <li key={item.number} id={`${id}-${i}`} role="option" aria-selected={i === active} title={item.url}
            onClick={() => picker.pick(item)} onMouseMove={() => i !== active && picker.setActive(i)}
            className={cx("mx-1 flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm", i === active && "bg-zinc-800")}>
            <Icon className={cx("h-4 w-4 shrink-0", tone)} aria-hidden />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="line-clamp-2 min-w-0 wrap-anywhere text-zinc-100"><span className="text-zinc-400 tabular-nums">#{item.number}</span> {item.title}</span>
              <span className="truncate text-xs text-zinc-500">{item.kind === "pull" ? "Pull request" : "Issue"} · {item.state}</span>
            </span>
          </li>
        })}
      </ul>
    </div>, document.body,
  )
}
