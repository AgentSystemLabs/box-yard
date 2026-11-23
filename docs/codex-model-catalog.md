# Codex model catalog verification

Updated 2026-11-23 from this machine's `~/.codex/models_cache.json`. That file reports `client_version: 0.171.0` and `fetched_at` **2026-11-23T17:39:42Z**. Only model metadata was read. No credentials, live Settings, token refresh, or model request was made. The earlier snapshot was codex-cli 0.159.2 on 2026-11-03.

The Settings select lists `latest`, then every `visibility: list` entry from that cache, in the cache's priority order:

| CLI model name | Supported CLI reasoning values |
| --- | --- |
| `latest` | low, medium, high, xhigh, max, ultra |
| `gpt-6.2-sol` | low, medium, high, xhigh, max, ultra |
| `gpt-6.2-astra` | low, medium, high, xhigh, max, ultra |
| `gpt-6.1-terra` | low, medium, high, xhigh, max, ultra |
| `gpt-6.1-sol` | low, medium, high, xhigh, max, ultra |
| `gpt-6-astra` | low, medium, high, xhigh, max, ultra |
| `gpt-6-sol` | low, medium, high, xhigh, max, ultra |
| `gpt-6-luna` | low, medium, high, xhigh, max |
| `gpt-5.6-sol` | low, medium, high, xhigh, max, ultra |
| `gpt-5.6-terra` | low, medium, high, xhigh, max, ultra |
| `gpt-5.6-luna` | low, medium, high, xhigh, max |

Hidden entries `gpt-reserve` and `codex-auto-review` are excluded. `latest` is a Box Yard setting, not a CLI id. Saving it stores the string `latest`. `codexModel` resolves it when a turn launches, to `gpt-6.2-sol`: catalog priority 1, and the Codex CLI's default in this cache. GPT-6.2 Astra stays an explicit pick. There is no environment variable for this. A saved concrete id, including `gpt-6.1-sol`, stays pinned. The built-in default for a Codex task that never picked a model remains **gpt-6.1-sol / xhigh**. Claude's defaults are unchanged.

[Official Codex models documentation](https://learn.chatgpt.com/docs/models) confirmed 6.1 Sol, Astra, 6.1 Terra and Luna CLI names on 2026-11-03, the `--model`/`-m` argument, and model-dependent Max/Ultra availability. Terra requires CLI 0.159.0+. [The public API Sol page](https://developers.openai.com/api/docs/models/gpt-6.1-sol) documents low, medium, high, xhigh and max. Ultra is a **Codex delegation mode**, not a public API reasoning value. The 6.2 rows above are the 2026-11-23 cache's `gpt-6.2-sol` and `gpt-6.2-astra`, in that priority order. This pass did not re-read the public docs for their effort values; the cache lists low through ultra for both.

The cached 5.6 names are account/CLI catalog entries; this discovery does **not** establish their public API IDs or alias targets. They are labeled as CLI catalog choices. No alias targets are guessed. A cached list is a dated snapshot, not a guarantee of another account's entitlement or a remote box's installed version. No live authenticated model request or token refresh was attempted; this snapshot does not establish the current health of remote authentication. The app ships this snapshot and does not query credentials to refresh it.

## Saved choices and routing

Only the selected harness's controls are visible. Changing the harness, model or effort stays in the Settings draft until Save. Separate Claude and Codex fields keep each draft when switching.

Existing explicit Codex models, including the empty “Codex CLI default” choice, are retained. A saved name absent from the snapshot stays selectable with an unverified warning; users explicitly select its replacement. Syntax validation still rejects Claude names and malformed new writes. Unsupported model/effort pairs stay visible with a warning instead of silently changing the effort.

An existing explicit `agentEffort` initializes Codex's effective effort. Reads do not migrate the store; saving Codex's effort or subsequently editing Claude's effort preserves that value independently. Unset Codex effort resolves to xhigh, including when the project selects Codex while the global harness is Claude. Task and project routing choices retain priority; saved harness settings beat YAML defaults/fallback, which beat the built-in defaults. The runner receives the resolved model and `model_reasoning_effort`. No live settings migration runs.
