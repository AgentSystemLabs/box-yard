// Where a project's agents run: on the computer that runs Box Yard (the local runner, the default on fresh installs), in Upstash boxes,
// on a RunPod GPU pod of the project's own (shared/runpod.ts, docs/runpod.md), or in a Docker container of the
// project's own on the computer that runs Box Yard (shared/docker.ts, docs/docker.md), or on one of Cody's own
// computers over SSH, picked by label (shared/machines.ts, docs/machines.md).

export const RUNNERS = ["box", "local", "gpu", "docker", "ssh"] as const
export type Runner = (typeof RUNNERS)[number]

/** Anything unknown (NULL from older rows, a typo) is "box", so a project only runs locally when someone chose it. */
export const normalizeRunner = (v: unknown): Runner => (v === "local" || v === "gpu" || v === "docker" || v === "ssh" ? v : "box")

/** A task's own runner (Task.runsOn), which wins over its project's in both directions; null follows the project. */
export const parseRunsOn = (v: unknown): Runner | null => (v === "local" || v === "box" || v === "gpu" || v === "docker" || v === "ssh" ? v : null)

export const RUNNER_LABEL: Record<Runner, string> = { box: "Upstash box", local: "This computer", gpu: "GPU (RunPod, Vast.ai or Daytona)", docker: "Docker container", ssh: "SSH machine" }

/** "an Upstash box", "this computer", "a GPU pod", "a Docker container", "one of your SSH machines": for sentences. */
export const RUNNER_PHRASE: Record<Runner, string> = {
  box: "an Upstash box",
  local: "this computer",
  gpu: "a GPU pod (RunPod, Vast.ai or Daytona)",
  docker: "a Docker container on this computer",
  ssh: "one of your SSH machines",
}

/**
 * The runners the onboarding choice (the default for new projects) offers, the fresh-install default first
 * (BOXYARD_DEFAULT_RUNNER, server/config.ts). RunPod GPU is picked per project.
 */
export const SETUP_RUNNERS = ["local", "box", "docker"] as const
export type SetupRunner = (typeof SETUP_RUNNERS)[number]

/**
 * What Settings › Box providers offers as the default for new projects: the setup runners, Daytona (a project on the
 * GPU runner with Daytona as its cloud, CPU only or with a GPU) and SSH machines. The first-run card offers only
 * SETUP_RUNNERS.
 */
export const DEFAULT_PROVIDERS = ["local", "box", "docker", "daytona", "ssh"] as const
export type DefaultProvider = (typeof DEFAULT_PROVIDERS)[number]

export const isDefaultProvider = (v: unknown): v is DefaultProvider => (DEFAULT_PROVIDERS as readonly unknown[]).includes(v)

export const DEFAULT_PROVIDER_LABEL: Record<DefaultProvider, string> = { local: "This computer", box: "Upstash boxes", docker: "Docker", daytona: "Daytona", ssh: "SSH machines" }

/** The runner a default provider's new projects get (Daytona's also get gpuProvider "daytona"). */
export const providerRunner = (p: DefaultProvider): Runner => (p === "daytona" ? "gpu" : p)

/**
 * The one virtual box every local-runner task lives on. It is never a `boxes` row, so box reconcile, the pool
 * (Max boxes, Max tasks running at once), cost metering, the janitor and the Boxes page never see it, and it can't be lost or
 * swept. It must not start with `local-`: that prefix is LocalProvider's mock boxes (providers/auto.ts).
 */
export const LOCAL_BOX_ID = "this-computer"

export const isLocalRunnerBox = (id: string | null | undefined): boolean => id === LOCAL_BOX_ID

/** Shown on the "Runs on" setting and on each local task's header. */
export const LOCAL_UNSANDBOXED =
  "Tasks on this computer are not sandboxed: their agents run as your user, with your files, keys, network and logged-in tools. Only use it for repos and prompts you trust."

/** Settings › Tasks running at once on this computer: how many local turns may run at once. */
export const LOCAL_AGENTS_LIMITS = { min: 1, max: 32 } as const
