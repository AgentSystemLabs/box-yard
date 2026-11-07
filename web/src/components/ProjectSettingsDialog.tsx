// Keep write-only project configuration available without exposing the retired project page.
import { useState } from "react"
import { useSearchParams } from "wouter"
import { useProjects } from "../lib/queries"
import { PROJECT_SETTINGS_PARAM, useOpenProjectSettings } from "../lib/projectSettings"
import { confirmDialog } from "../lib/confirm"
import { Modal } from "./Modal"
import { LoadFailed, lazyPart } from "./LazyPart"
import { Button, Select } from "./ui"
import { Loading } from "./Loading"

// The project page's settings are most of ProjectView.tsx: a chunk of their own, out of the first load.
const ProjectSettings = lazyPart(() => import("./ProjectView").then((m) => m.ProjectSettings), {
  Loading: () => <div className="p-4 sm:p-5"><Loading label="Loading the project" /></div>,
  Failed: () => <div className="p-4 sm:p-5"><LoadFailed /></div>,
})

export function ProjectSettingsPicker() {
  const projects = useProjects()
  const [picked, setPicked] = useState("")
  const open = useOpenProjectSettings()
  const id = picked || projects.data?.[0]?.id || ""
  if (projects.isError) return <div role="alert">Couldn't load projects. <Button onClick={() => void projects.refetch()}>Retry</Button></div>
  if (projects.isLoading) return <Loading count={1} label="Loading projects" />
  if (!id) return <p className="text-sm text-zinc-400">No projects yet. Ask the Coordinator to create one, or choose New project in the command palette.</p>
  return (
    <div className="@container space-y-3">
      <label className="block space-y-2 text-sm text-zinc-300">Project
        <Select className="min-h-11 w-full" value={id} onChange={(e) => setPicked(e.target.value)}>
          {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
      </label>
      <Button onClick={() => open(id)}>Configure project</Button>
    </div>
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
