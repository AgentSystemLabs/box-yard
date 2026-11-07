// Each GPU cloud's own list of GPUs, in one shape: for Settings › Box providers (the default cloud's list), the
// pickers, and the chats' "@" list, where `@gpu:<cloud>:<slug>` asks for one GPU on one cloud (shared/runTargets.ts).
// The clouds' own guides stay the source: RUNPOD_GPU_GUIDE, VAST_GPU_GUIDE and DAYTONA_GPU_GUIDE. A cloud's
// configured types that its guide lacks (a RunPod id picked from the live catalog) join its list too.

import { GPU_PROVIDER_LABEL, type GpuProvider } from "./gpu.js"
import { DEFAULT_RUNPOD_SETTINGS, RUNPOD_GPU_GUIDE, gpuHint, shortGpu } from "./runpod.js"
import { DEFAULT_VAST_SETTINGS, VAST_GPU_GUIDE, vastGpuHint } from "./vast.js"
import { DAYTONA_CPU, DAYTONA_GPU_GUIDE, DEFAULT_DAYTONA_SETTINGS, daytonaGpuHint, daytonaGpuLabel } from "./daytona.js"

/** One GPU a cloud offers (or Daytona's "CPU only"). */
export interface GpuChoice {
  provider: GpuProvider
  /** As the cloud's API and its settings spell it: "NVIDIA RTX A5000" (RunPod), "RTX A5000" (Vast.ai), "RTX-4090" or "CPU" (Daytona). */
  id: string
  /** Its part of an "@" token: lowercase, no "NVIDIA ", anything else as "-": "rtx-a5000", "rtx-4090", "h100", "cpu". */
  slug: string
  /** "RTX A5000", "RTX 4090", "CPU only". */
  label: string
  /** Memory, rough price and what it's good for, or null for a type with no guide entry. */
  hint: string | null
}

/** "NVIDIA GeForce RTX 3070" → "rtx-3070", "RTX-PRO-6000" → "rtx-pro-6000". */
export const gpuSlug = (id: string) =>
  shortGpu(id.trim())
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

const choice = (provider: GpuProvider, id: string): GpuChoice => ({
  provider,
  id,
  slug: gpuSlug(id),
  label: provider === "daytona" ? daytonaGpuLabel(id) : shortGpu(id),
  hint: provider === "runpod" ? gpuHint(id) : provider === "vast" ? vastGpuHint(id) : daytonaGpuHint(id),
})

const GUIDE_IDS: Record<GpuProvider, string[]> = {
  runpod: Object.keys(RUNPOD_GPU_GUIDE),
  vast: Object.keys(VAST_GPU_GUIDE),
  // Daytona's CPU-only sandbox is one of its choices too, after its GPUs.
  daytona: [...Object.keys(DAYTONA_GPU_GUIDE), DAYTONA_CPU],
}

/** Each cloud's GPU types before anyone picks: what its settings ask for out of the box. */
export const DEFAULT_GPU_TYPES: Record<GpuProvider, readonly string[]> = {
  runpod: DEFAULT_RUNPOD_SETTINGS.gpuTypes,
  vast: DEFAULT_VAST_SETTINGS.gpuTypes,
  daytona: DEFAULT_DAYTONA_SETTINGS.gpuTypes,
}

/**
 * A cloud's GPUs: its guide's, cheapest first as the guide lists them, then any of `configured` (its settings' types)
 * the guide lacks. One per slug.
 */
export function gpuChoices(provider: GpuProvider, configured: readonly string[] = []): GpuChoice[] {
  const out: GpuChoice[] = []
  const seen = new Set<string>()
  for (const id of [...GUIDE_IDS[provider], ...configured]) {
    const c = choice(provider, id)
    if (!c.slug || seen.has(c.slug)) continue
    seen.add(c.slug)
    out.push(c)
  }
  return out
}

/** The GPU a slug (or an id in any cloud's spelling) names on `provider`, or null when that cloud has none by that name. */
export function findGpuChoice(provider: GpuProvider, slugOrId: string, configured: readonly string[] = []): GpuChoice | null {
  const slug = gpuSlug(slugOrId)
  return gpuChoices(provider, configured).find((c) => c.slug === slug) ?? null
}

/** Whether two GPU names are the same GPU, whichever cloud spelled them ("NVIDIA RTX A5000" and "RTX A5000"). */
export const sameGpu = (a: string | null | undefined, b: string | null | undefined) => Boolean(a && b && gpuSlug(a) === gpuSlug(b))

/** "RTX A5000 or A40", "CPU only": a cloud's types in a few words. */
export const gpuTypesWords = (provider: GpuProvider, types: readonly string[]) => {
  const names = types.map((t) => choice(provider, t).label)
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`
}

/** "Daytona H100", "RunPod RTX A5000": one GPU on one cloud, for placement lines and the task header. */
export const gpuPickLabel = (provider: GpuProvider, type: string | null | undefined) =>
  type ? `${GPU_PROVIDER_LABEL[provider]} ${choice(provider, type).label}` : `${GPU_PROVIDER_LABEL[provider]} GPU`
