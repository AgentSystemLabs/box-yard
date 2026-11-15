# boxd machines (docs: https://docs.boxd.sh)

[boxd](https://boxd.sh) is a third "cloud boxes" option: worker boxes are persistent,
hardware-isolated Linux VMs (Frankfurt or New York) with **node, git, Claude Code and Codex
already installed**, so a box is ready in seconds instead of installing anything.

## Set up

1. Create an API key at <https://app.boxd.sh/keys> (`boxd auth keys create my-yard` works too).
2. Add it in Settings › Box providers (the "boxd API key" field), or put it in `.env`:

   ```
   BOXD_API_KEY=bxd_...
   ```

No restart needed for a key saved in Settings. With no Upstash key and no `BOX_PROVIDER`, new
boxes become boxd machines once the key is set; `BOX_PROVIDER=boxd` forces it either way (and
`BOX_PROVIDER=local` keeps every box in folders on this machine).

## How it maps

- **Sizes**: Box Yard's small / medium / large become boxd's 1 vCPU/4 GiB, 2 vCPU/8 GiB and
  4 vCPU/16 GiB. Every machine has a fixed 100 GB disk.
- **Names**: machines are named `byard-<random>` (names are unique across all of boxd), which is
  also how Box Yard finds its own machines for cleanup — keep other machines out of that prefix.
- **Snapshots**: boxd snapshots are named org-wide; the snapshot id Box Yard shows is that name.
- **Public URLs**: a task's preview port gets a `p<port>` subdomain proxy on the machine.
- **Idle**: boxd hibernates a machine after 4 hours with no traffic (disk-only billing), and
  Box Yard's janitor still deletes idle boxes per its own settings.
- **`usage`**: boxd bills active vCPU only and exposes no per-machine compute totals, so the
  Boxes page estimates size and measures disk, like local boxes.

## Notes

- With `BOX_PROVIDER=boxd` and a saved key, the agent credential flow is the same as Upstash:
  each turn brings its own Claude/Codex login (task.json), nothing is baked into the machine.
- A mixed install (Upstash boxes from before + a boxd key later) routes existing non-local box
  ids to the boxd provider while it is the cloud one; health for old Upstash boxes then reads
  "unknown". Pick one cloud per data folder.
- The SDK talks gRPC to `boxd.sh:9443` and honors `HTTPS_PROXY`/`HTTP_PROXY` if set.

> AI生成
