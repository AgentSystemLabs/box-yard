# boxd machines (docs: https://docs.boxd.sh)

[boxd](https://boxd.sh) is a third "cloud boxes" option: worker boxes are persistent,
hardware-isolated Linux VMs (Frankfurt or New York) with **node, git, Claude Code and Codex
already installed**, so a box is ready in seconds instead of installing anything.

## Set up

1. Create an API key at <https://app.boxd.sh/keys> (`boxd auth keys create my-yard` works too).
2. Add it in Settings › Box providers (the "boxd API key" field — its Test button lists the account's
   machines), or put it in `.env`:

   ```
   BOXD_API_KEY=bxd_...
   ```

No restart needed for a key saved in Settings. With no Upstash key and no `BOX_PROVIDER`, new
boxes become boxd machines once the key is set; `BOX_PROVIDER=boxd` forces it either way (and
`BOX_PROVIDER=local` keeps every box in folders on this machine). Saving an Upstash key later
moves new boxes back to Upstash, the same as before.

`npm run smoke:boxd` checks the provider end to end against the real API (it spends a few cents:
one 1 vCPU machine for a few minutes, deleted at the end).

## How it maps

- **Isolation**: every machine is created isolated — no metadata endpoint, no in-VM `boxd` CLI,
  no place on the org's network — so a box (or a prompt injection in a repo it reads) can't reach
  the boxd account or its sibling machines. Restores re-isolate even an unisolated snapshot.
- **Sizes**: Box Yard's small / medium / large become boxd's 1 vCPU/4 GiB, 2 vCPU/8 GiB and
  4 vCPU/16 GiB. Every machine has a fixed 100 GB disk.
- **Ids and names**: box ids are `boxd-<machine id>`, so each box keeps going to the provider that
  made it whatever keys are set later. Machines are named `byard-<random>` (unique across all of
  boxd) and labeled with this install's `by-<id>` label (and a `p-<project>` one): the leftover
  sweep only ever touches machines with this install's label, so another Box Yard on the same
  account is safe. Keep other machines out of the `byard-` name prefix.
- **Snapshots**: boxd snapshots are named org-wide; the snapshot id Box Yard shows is that name
  with the `boxd-` prefix, so it routes back to this provider.
- **Public URLs**: a task's preview port gets a `p<port>` subdomain proxy on the machine. The
  machine's main address is never used for previews: boxd's bot protection answers non-browser
  clients there with a challenge page, while subdomain proxies are never checked. A new proxy's
  certificate takes a few seconds to come up.
- **Idle**: boxd hibernates a machine after 4 hours with no traffic (disk-only billing), and
  Box Yard's janitor still deletes idle boxes per its own settings.
- **`usage`**: boxd bills active vCPU only and exposes no per-machine compute totals, so the
  Boxes page estimates size and measures disk, like local boxes.

## Notes

- With `BOX_PROVIDER=boxd` and a saved key, the agent credential flow is the same as Upstash:
  each turn brings its own Claude/Codex login (task.json), nothing is baked into the machine.
- A mixed install (Upstash boxes from before + a boxd key later) keeps every box with its own
  cloud: box ids carry their provider's mark, so health and turns keep working while new boxes
  follow the active cloud. Pick one cloud per data folder anyway — a project snapshot only
  restores on the cloud that took it.
- The SDK talks gRPC to `boxd.sh:9443` and honors `HTTPS_PROXY`/`HTTP_PROXY` if set. It loads
  lazily, on the first boxd call that needs it, so installs that never use boxd never load it.

