import type { WorkerSize } from "../../shared/types.js"
import { errorMessage } from "../util/retry.js"
import { isBoxdBox } from "./boxd.js"
import type { BoxHealth, BoxProvider, BoxSnapshotInfo, BoxUsageProbe, ExecResult } from "./types.js"

/** Local boxes are folders named local-<id> (LocalProvider.create), boxd boxes boxd-<machine id>; every other id is an Upstash box. */
export const isLocalBox = (boxId: string) => boxId.startsWith("local-")

/**
 * The provider when BOX_PROVIDER isn't set and the env has no cloud key: new boxes are folders on this machine
 * until a key is saved in Settings › Credentials, then that cloud's boxes — Upstash's when both are saved —
 * with no restart, because the cloud is asked for on every call. Every box keeps going to the provider that
 * made it (local- folder ids, boxd- machine ids, anything else an Upstash box), so saving or removing a key
 * never strands a box.
 */
export class AutoProvider implements BoxProvider {
  constructor(
    private readonly local: BoxProvider,
    private readonly upstash: BoxProvider,
    private readonly boxd: BoxProvider,
    /** Where new boxes come from right now: local folders, or a cloud with a saved key (Upstash first). */
    private readonly cloud: () => BoxProvider,
    /** The clouds with a saved key, where leftovers are swept: possibly both, whatever `cloud` picks for new boxes. */
    private readonly clouds: () => BoxProvider[],
  ) {}

  /** Where new boxes come from right now. */
  private get active(): BoxProvider {
    return this.cloud()
  }

  of(boxId: string): BoxProvider {
    return isLocalBox(boxId) ? this.local : isBoxdBox(boxId) ? this.boxd : this.upstash
  }

  get name() {
    return this.active.name
  }
  get nodeBin() {
    return this.active.nodeBin
  }
  get claudeBin() {
    return this.active.claudeBin
  }
  get codexBin() {
    return this.active.codexBin
  }
  get opencodeBin() {
    return this.active.opencodeBin
  }
  get cursorBin() {
    return this.active.cursorBin
  }

  root(boxId: string) {
    return this.of(boxId).root(boxId)
  }
  create(opts: { labels: string[]; size?: WorkerSize; snapshotId?: string }) {
    return this.active.create(opts)
  }
  /** A snapshot goes to the provider of its box; local snapshot ids start with local- like local box ids. */
  snapshot(boxId: string, name: string): Promise<BoxSnapshotInfo> {
    const p = this.of(boxId)
    if (!p.snapshot) throw new Error(`${p.name} boxes can't be snapshotted`)
    return p.snapshot(boxId, name)
  }
  async deleteSnapshot(snapshotId: string): Promise<void> {
    const p = isLocalBox(snapshotId) ? this.local : isBoxdBox(snapshotId) ? this.boxd : this.upstash
    if (p.deleteSnapshot) await p.deleteSnapshot(snapshotId)
  }
  snapshotDirs(boxId: string) {
    return this.of(boxId).snapshotDirs?.(boxId) ?? { home: "$HOME", tmp: "/tmp" }
  }
  health(boxId: string): Promise<BoxHealth> {
    return this.of(boxId).health(boxId)
  }
  wake(boxId: string) {
    return this.of(boxId).wake(boxId)
  }
  exec(boxId: string, command: string): Promise<ExecResult> {
    return this.of(boxId).exec(boxId, command)
  }
  execStream(boxId: string, command: string, onOutput: (chunk: string) => void) {
    return this.of(boxId).execStream(boxId, command, onOutput)
  }
  hold(boxId: string, command: string, signal: AbortSignal) {
    return this.of(boxId).hold(boxId, command, signal)
  }
  writeFile(boxId: string, filePath: string, content: string | Buffer) {
    return this.of(boxId).writeFile(boxId, filePath, content)
  }
  readFile(boxId: string, filePath: string) {
    return this.of(boxId).readFile(boxId, filePath)
  }
  uploadFile(boxId: string, localPath: string, destination: string) {
    return this.of(boxId).uploadFile(boxId, localPath, destination)
  }
  publicUrl(boxId: string, port: number) {
    return this.of(boxId).publicUrl(boxId, port)
  }
  destroy(boxId: string) {
    return this.of(boxId).destroy(boxId)
  }
  /** Leftovers are looked for on every cloud with a key, and only a cloud's own provider can list there. */
  async listIds(label: string): Promise<string[]> {
    const ids: string[] = []
    for (const p of this.clouds()) {
      if (!p.listIds) continue
      // One cloud failing (network, 5xx) shouldn't stop the other's sweep; cleanupOrphanBoxes logs the rest.
      ids.push(
        ...(await p.listIds(label).catch((err: unknown) => {
          console.warn(`[box-yard] leftover sweep skipped (${p.name}): ${errorMessage(err)}`)
          return []
        })),
      )
    }
    return ids
  }
  async usage(boxId: string): Promise<BoxUsageProbe> {
    const p = this.of(boxId)
    return p.usage ? p.usage(boxId) : { source: "estimated" }
  }
}
