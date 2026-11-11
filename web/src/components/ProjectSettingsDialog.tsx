// Keep write-only project configuration available without exposing the retired project page.
import { useState } from "react"
import { useSearchParams } from "wouter"
import { ChevronRight } from "lucide-react"
import { useProjects } from "../lib/queries"
import { useProjectColor } from "../lib/taskTiles"
import { PROJECT_SETTINGS_PARAM, useOpenProjectSettings } from "../lib/projectSettings"
import { confirmDialog } from "../lib/confirm"
import { Modal } from "./Modal"
import { LoadFailed, lazyPart } from "./LazyPart"
import { Button } from "./ui"
import { Loading } from "./Loading"
import { ProjectAvatar, projectColorStyle } from "./TaskIcon"
import type { Project } from "../../../shared/types"

// The project page's settings are most of ProjectView.tsx: a chunk of their own, out of the first load.
const ProjectSettings = lazyPart(() => import("./ProjectView").then((m) => m.ProjectSettings), {
  Loading: () => <div className="p-4 sm:p-5"><Loading label="Loading the project" /></div>,
  Failed: () => <div className="p-4 sm:p-5"><LoadFailed /></div>,
})

/** Settings › Projects: every project as a row that opens its settings. */
export function ProjectSettingsPicker() {
  const projects = useProjects()
  if (projects.isError) return <div role="alert">Couldn't load projects. <Button onClick={() => void projects.refetch()}>Retry</Button></div>
  if (projects.isLoading) return <Loading label="Loading projects" />
  if (!projects.data?.length) return <p className="text-sm text-zinc-400">No projects yet. Ask the Coordinator to create one, or choose New project in the command palette.</p>
  return (
    <ul aria-label="Projects" className="-mx-2.5 space-y-0.5" data-testid="project-settings-list">
      {projects.data.map((p) => <ProjectRow key={p.id} project={p} />)}
    </ul>
  )
}

function ProjectRow({ project }: { project: Project }) {
  const open = useOpenProjectSettings()
  const color = useProjectColor(project.id)
  return (
    <li>
      <button
        type="button"
        onClick={() => open(project.id)}
        title={`${project.name} settings`}
        className="flex min-h-11 w-full items-center gap-3 rounded-lg px-2.5 py-1.5 text-left text-sm text-zinc-200 hover:bg-zinc-900 focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none"
      >
        <ProjectAvatar src={project.iconUrl} className="h-6 w-6 rounded-md">
          <span aria-hidden style={projectColorStyle(color)} className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-(--pc)/15 text-xs font-semibold text-(--pc) uppercase">
            {project.name.trim().charAt(0)}
          </span>
        </ProjectAvatar>
        <span className="min-w-0 flex-1">
          <span className="block truncate">{project.name}</span>
          <span className="block truncate text-xs text-zinc-500">{project.repo ?? "No repo"}</span>
        </span>
        <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-zinc-500" />
      </button>
    </li>
  )
}

export function ProjectSettingsHost() {
  const [params, setParams] = useSearchParams()
  const id = params.get(PROJECT_SETTINGS_PARAM)
  if (!id) return null
  return <ProjectSettingsDialog key={id} id={id} onClose={() => setParams((p) => { p.delete(PROJECT_SETTINGS_PARAM); return p }, { replace: true })} />
}

function ProjectSettingsDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const projects = useProjects()
  const project = projects.data?.find((p) => p.id === id)
  const [dirty, setDirty] = useState(false)
  const close = async () => {
    if (dirty && !(await confirmDialog({ title: "Discard unsaved changes?", body: "Your project settings haven't been saved.", confirmLabel: "Discard", cancelLabel: "Keep editing", danger: true }))) return
    onClose()
  }
  return (
    // Sized and laid out as Settings is: category tabs beside the panel (SettingsTabs), and one Save under them.
    <Modal
      title={project ? `${project.name} settings` : "Project settings"}
      size="xl"
      dirty={dirty}
      onClose={() => void close()}
      className="settings-dialog sm:h-[min(88dvh,56rem)]"
      bodyClassName="flex min-h-0 flex-1 flex-col"
    >
      {project ? <ProjectSettings project={project} onDone={onClose} onDirtyChange={setDirty} />
        : <div className="settings-body p-4 sm:p-5">
          {projects.isError ? <div role="alert">Couldn't load this project. <Button onClick={() => void projects.refetch()}>Retry</Button></div>
            : projects.isLoading ? <Loading label="Loading the project" /> : <p>Project not found.</p>}
        </div>}
    </Modal>
  )
}
