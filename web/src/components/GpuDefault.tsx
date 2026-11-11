// What each GPU cloud's page shows where its "Use for GPU projects" checkbox was: which cloud is Settings › Box
// providers › Default GPU cloud, and a way there to change it. One setting, so two clouds can't both say yes.
import { useAgentSettings } from "../lib/queries"
import { DEFAULT_GPU_PROVIDER, GPU_PROVIDER_LABEL, type GpuProvider } from "../../../shared/gpu"
import { useOpenSettings } from "./SettingsHost"
import { Row, SettingsLink } from "./SettingsBlocks"

/** `draft`: the Settings dialog's Default GPU cloud, unsaved picks included; without it, the saved one. */
export function GpuDefaultRow({ cloud, id, draft }: { cloud: GpuProvider; id: string; draft?: GpuProvider }) {
  const settings = useAgentSettings()
  const open = useOpenSettings()
  const current = draft ?? settings.data?.settings.gpuProvider ?? DEFAULT_GPU_PROVIDER
  const mine = current === cloud
  return (
    <Row
      id={id}
      label="Default GPU cloud"
      help={<>Where @gpu tasks, and GPU projects without a cloud of their own (Project › Settings › Boxes › GPU cloud), run. One cloud is the default; <SettingsLink section="runners">Settings › Box providers</SettingsLink> picks it.</>}
    >
      <p className="text-sm text-zinc-300" data-testid={`${cloud}-gpu-default`}>
        {mine ? `Yes: ${GPU_PROVIDER_LABEL[cloud]} is the default` : `No: ${GPU_PROVIDER_LABEL[current]} is the default`}
      </p>
      <button type="button" id={id} onClick={() => open("runners")} className="inline-flex min-h-11 items-center text-left text-xs text-yard-300 hover:underline sm:min-h-0">
        Change it in Box providers
      </button>
    </Row>
  )
}
