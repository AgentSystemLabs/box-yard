# Codex model catalog verification

Verified 2026-11-03 using the **OpenAI Docs** skill, official documentation first, then read-only installed CLI discovery. Installed version: `codex-cli 0.159.2`. The account's `models_cache.json` reports `client_version: 0.159.2`, fetched **2026-11-03**. Only model metadata was inspected; no credentials, live Settings, or running services were changed.

The Settings select contains every `visibility: list` entry from that cache:

| CLI model name | Supported CLI reasoning values |
| --- | --- |
| `gpt-6.1-sol` | low, medium, high, xhigh, max, ultra |
| `gpt-6-astra` | low, medium, high, xhigh, max, ultra |
| `gpt-6.1-terra` | low, medium, high, xhigh, max, ultra |
| `gpt-6-sol` | low, medium, high, xhigh, max, ultra |
| `gpt-6-luna` | low, medium, high, xhigh, max |
| `gpt-5.6-sol` | low, medium, high, xhigh, max, ultra |
| `gpt-5.6-terra` | low, medium, high, xhigh, max, ultra |
| `gpt-5.6-luna` | low, medium, high, xhigh, max |

Hidden entries `gpt-reserve` and `codex-auto-review` are excluded. The cache's default reasoning is **low** for 6.1 Sol; Box Yard deliberately defaults task agents on Codex to **gpt-6.1-sol / xhigh**, as requested. Claude's defaults are unchanged.

[Official Codex models documentation](https://learn.chatgpt.com/docs/models) confirms 6.1 Sol, Astra, 6.1 Terra and Luna CLI names, the `--model`/`-m` argument, and model-dependent Max/Ultra availability. Terra requires CLI 0.159.0+. [The public API Sol page](https://developers.openai.com/api/docs/models/gpt-6.1-sol) documents low, medium, high, xhigh and max. Ultra is a **Codex delegation mode**, not a public API reasoning value.

The cached 5.6 names are account/CLI catalog entries; this discovery does **not** establish their public API IDs or alias targets. They are labeled as CLI catalog choices. No alias targets are guessed. A cached list is a dated snapshot, not a guarantee of another account's entitlement or a remote box's installed version. No live authenticated model request or token refresh was attempted; remote authentication is under repair. The app ships this snapshot and does not query credentials to refresh it.

## Saved choices and routing

Only the selected harness's controls are visible. Changing the harness, model or effort stays in the Settings draft until Save. Separate Claude and Codex fields keep each draft when switching.

Existing explicit Codex models, including the empty “Codex CLI default” choice, are retained. A saved name absent from the snapshot stays selectable with an unverified warning; users explicitly select its replacement. Syntax validation still rejects Claude names and malformed new writes. Unsupported model/effort pairs stay visible with a warning instead of silently changing the effort.

An existing explicit `agentEffort` initializes Codex's effective effort. Reads do not migrate the store; saving Codex's effort or subsequently editing Claude's effort preserves that value independently. Unset Codex effort resolves to xhigh, including when the project selects Codex while the global harness is Claude. Task and project routing choices retain priority; saved harness settings beat YAML defaults/fallback, which beat the built-in defaults. The runner receives the resolved model and `model_reasoning_effort`. No live settings migration runs.
