// A Captain's chat before its first message. A project with no tasks yet gets its next step: what the Captain does,
// and requests to start from. One that has tasks gets questions about them. Picking one puts it in the Composer
// without sending it, as the Coordinator's TryFirst does, so it can be edited first.
import { githubRepo } from "../lib/linkify"
import { useHasTasks } from "../lib/queries"
import { useProjectColor } from "../lib/taskTiles"
import { projectColorStyle } from "./TaskIcon"
import { CaptainIcon } from "./CaptainIcon"
import type { Project } from "../../../shared/types"

/** What an empty Captain chat offers to start from. Issues and PRs only come up for a GitHub repo. */
export function captainStarters(project: Pick<Project, "name" | "repo">, hasTasks: boolean): string[] {
  const { name } = project
  if (hasTasks) return [`What's open in ${name}?`, "Summarize what the agents finished today", "Which tasks need me?"]
  const repo = githubRepo(project.repo)
  if (repo)
    return [
      `Pick the easiest open issue in ${repo} and fix it in a PR`,
      `List the open issues in ${repo} and suggest which to start with`,
      `Look through ${repo} and tell me the 3 riskiest parts of the code`,
    ]
  if (project.repo?.trim()) return [`Look through the ${name} repo and tell me the 3 riskiest parts of the code`, `Find one small bug in the ${name} repo and fix it`]
  return [`Plan the first steps for ${name}, then start on the first one`, `What do you need from me to get started on ${name}?`]
}

export function EmptyCaptain({ project, onPick }: { project: Project; onPick: (text: string) => void }) {
  // Until the task list loads, the questions: they suit any project, where "its first task" is wrong for a busy one.
  const hasTasks = useHasTasks(project.id) ?? true
  const color = useProjectColor(project.id)
  return (
    <div data-testid="captain-empty" className="flex flex-col items-center pt-[8dvh] text-center">
      {/* The Captain's icon, in its project's colour as everywhere. */}
      <span style={projectColorStyle(color)} className={color ? "text-(--pc)" : "text-zinc-300"}>
        <CaptainIcon projectId={project.id} className="h-6 w-6" />
      </span>
      <h2 className="mt-3 max-w-md text-lg font-semibold text-balance wrap-anywhere text-zinc-50">
        {hasTasks ? `Ask the ${project.name} Captain` : `Give ${project.name} its first task`}
      </h2>
      <p className="mt-1.5 max-w-md text-sm text-zinc-400">
        {hasTasks
          ? "It keeps track of this project's tasks. Ask what's going on, or tell it what to do next."
          : "Tell the Captain what you want done, in plain English. It starts an agent on its own box and reports back here."}
      </p>
      <div role="group" aria-label="Start from" className="mt-4 grid w-full max-w-md gap-2">
        {captainStarters(project, hasTasks).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            className="min-h-11 rounded-xl border border-zinc-800 px-3.5 py-2.5 text-left text-sm leading-snug text-zinc-200 wrap-anywhere hover:border-zinc-700 hover:bg-zinc-900"
          >
            {s}
          </button>
        ))}
      </div>
      <p className="mt-4 max-w-md text-xs leading-relaxed text-zinc-500">Picking one puts it in the box below, so you can edit it before you send it.</p>
    </div>
  )
}
