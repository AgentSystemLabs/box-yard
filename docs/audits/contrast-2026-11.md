# Light and dark contrast audit

This audit covers the fixture states listed below, using the production build plus a gallery of actual shared React components. It is a contrast assessment, not a claim of complete WCAG conformance. Only disposable data was used; browser requests that could save settings, start tasks, delete data or contact providers were intercepted.

## Criteria and method

- [WCAG 2.2 SC 1.4.3](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html): normal text and placeholders at least 4.5:1; text at least 24 CSS px, or at least 18.667 CSS px and bold, at least 3:1. Compare unrounded ratios.
- [SC 1.4.11](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html): meaningful icons, identifiable field boundaries, switch thumb/track, chart marks and focus cues at least 3:1 against adjacent surfaces. Decorative dividers and redundant illustrations are distinguished from necessary control boundaries.
- [SC 2.4.7](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html): keyboard focus must be visible. This audit checks the authored indicator's contrast; it does not substitute AAA Focus Appearance for the AA requirement.

The scripts use Chromium's **computed styles**, convert CSS colours (including `oklch` and `color-mix`) to sRGB with canvas, and composite foreground/background alpha and ancestor group opacity. They inspect rendered, intersecting text, values, placeholders, informative icons, field boundaries on both sides, switch thumbs, chart fills, selected text and keyboard focus. Scroll containers are visited in overlapping steps. Each snapshot also runs axe's `color-contrast` rule. Existing colour transitions settle before state checks. The real working animation is paused at its dimmest frame (1 second into its 2 second cycle); reduced motion is separately exercised by the application route checks.

Images, masks, gradients, backdrop filters and overlapping siblings cannot be certified by that calculation. They are returned in `manual`, alongside axe `incomplete` results, for explicit review. Measurements are repeated observations, not counts of independent elements or defects. Text under a closed dialog, virtualised older history and offscreen content outside the small fixture are not silently counted as passing.

## Inventory and coverage matrix

The base matrix is **light and dark × 1440×1000 and 400×1000 CSS px** for every row. Theme follows a fresh browser context's colour preference; no actual appearance setting is saved.

| Surface | Fixture and states | Evidence runner |
| --- | --- | --- |
| Coordinator | User/assistant/tool/error messages, markdown, notice cards, project/Captain links, dates, context, composer | routes: `coordinator` |
| Captain | Same message roles, context, header, task rows | routes: `captain` |
| Task and subtask | Idle, failed, feedback, queued messages in queued/delivering/accepted/uncertain states, PR/header links, nested task navigation | routes: `task`, `subtask`, `failed-task`, `asking-task` |
| Sidebar and navigation | Working/starting/queued/idle/failed/feedback/waiting/PR-ready/done task rows; selected project/task, desktop sidebar and narrow drawer, every fixture task row hovered/focused, failed row selected | routes plus interactions |
| Project | Repository link, project settings, fields/defaults and new project dialog | routes: `project-settings` |
| Settings | Coordinator, projects, agents, runners, local, Upstash, credentials, identities, connectors, Docker, Daytona, machines, RunPod, Vast, hooks, limits, costs, notifications, voice, appearance, about; top and scrolled field groups | routes: 21 `settings-*` cases |
| Identity errors | Made-up unreadable token/unverified author, Test error, expanded author draft, Save error; identity validation from main retained | interactions |
| Connector sign-in | Fake OAuth start/paste panel and primary external sign-in link; no provider contacted | interactions |
| Search and picking | Chat switcher/filter where present, command palette selected result/filter, composer project/runner/harness pickers, selected draft | interactions |
| Dates | Selected day, work summary, explicit Jump to start/end | interactions |
| Boxes | Cloud meter, box/usage sheet with mock box, limits and notices | interactions |
| Schedules | Paused fixture, list/detail/new schedule, schedule delete confirmation without submitting | routes plus interactions |
| Usage | Populated model and token stacks, legends, tables, selected/hovered day | routes plus interactions |
| File preview | Generated markdown and black/white SVG previews | interactions |
| Shared controls | All Button variants, input/value/placeholder/invalid, native checkbox, select, switch on/off/inactive, hover and keyboard focus | components |
| Status and PRs | Live open-work/history PR list, still-readable stale merged row, task summary detail; every StatusBadge; open/draft/merged/closed PR chips, links, numbers and activity; PR sheet checks/review/conflicts/files | components plus interactions |
| Full shared palettes | Every chart colour on base/card/selected surfaces, all project and harness/runner composer tags | components |
| Project/status icons | All eight project colours, task/Captain bare and tiled working icons at animation trough on base/hover/selected surfaces; blue/yellow/red corner dots | components |
| Other chat states | Actual pending Coordinator/Captain/task/hook/side-thread message components, context meters at 30/80/95%, markdown/inline code/links/quotes/folded code and folded messages | components |
| Interruptions | Actual confirmation, new-task draft/options, health warning, error/info/task toasts, login/password error | components |

## Reproduce safely

Use a dedicated port and a **new** data directory. The seed creates its own directory; never substitute a real yard. It puts active task states only in read-only browser responses, never in the scheduler. Its project is `acme/example-app`, with push at turn end off. Browser storage and conversation persistence are not used.

```sh
npm ci
npx playwright-core install chromium
# On Linux, if required:
npx playwright-core install-deps chromium
npm run build
node scripts/a11y/seed-contrast.mjs
# Copy the printed NEW path into this environment variable, then keep this server running:
PORT=4000 HOST=127.0.0.1 BOXYARD_MOCK=1 BOXYARD_ALLOW_OPEN=1 \
  BOXYARD_DATA_DIR=/tmp/contrast-yard-PRINTED-PATH node dist/server/server/index.js
```

In another terminal:

```sh
npm run test:contrast -- http://localhost:4000 /tmp/contrast-routes
npm run test:contrast:interactions -- http://localhost:4000 /tmp/contrast-interactions
npm run test:contrast:components -- /tmp/contrast-components
```

Run browser jobs sequentially. The gallery starts a development-only Vite entry on loopback port 4001 and shuts it down on exit; it is outside the production web root. All three runners fail on calculated failures, axe violations or page exceptions and save JSON evidence/screenshots. They require a human to resolve `manual`/`incomplete` findings. `ONLY` (route-name regular expression) and `WIDTHS` (comma-separated CSS widths) allow focused route reruns. `TOUCH=1` enables a mobile viewport and coarse pointer. `ZOOM=1.25` additionally exercises CSS zoom (a layout stress check, not a certification of native browser zoom). `CHROMIUM_PATH`, `PLAYWRIGHT_MODULE` and `AXE_MODULE` can point at existing tools. The npm lock pins browser/axe packages; Chromium must be installed separately.

## Shared colour inventory and changes

| Shared source | Purpose and fix |
| --- | --- |
| `web/src/styles.css` zinc/accent theme tokens | Preserve semantic themes; stronger control outline, readable placeholder defaults, solid keyboard outline, selected-text ink, accessible pulse minimum, light project glyph ink |
| Action / on-action | Gold primary action with dark ink in both themes; reused by switches and connector sign-in |
| Yard / sky / merged / status accents | Yellow in-app links, sky external links, state-coloured PR glyphs retained; light Yard 300/400 made darker |
| `ui.tsx`, `Composer`, `ChatSwitcher`, `SendToMenu`, Settings search | Shared input/select/composer boundaries and focus states instead of low-alpha outlines |
| `TaskIcon`, `AgentIcon`, `WORKING_PULSE` | Existing working fade retained; shared pulse trough raised from 50% to 80% to keep meaningful glyphs visible |
| PR chips/activity, chat/pending/queued rows, hooks, schedules, stale PR rows, usage loading | Remove opacity from readable content; use existing words, disabled controls, dashed stale border or busy semantics to carry state |
| Markdown and previews | Remove fades across visible folded text/code; readable preview-arrow hover colour |
| Usage bars and legend swatches | Same categorical hues, darker rendering in light mode so selected-day tint still provides 3:1 |
| Health warning and notices | Remove dimming of active dismiss text and notice metadata on hover |

## Results

Browser: Chromium 158.0.8127.18, Playwright Core 1.65.0, axe-core 4.14.0, Linux headless. Source includes main through #31, retaining identity validation (#26), normal working titles (#27), immediate pending-message semantics (#30) and the new still status dots (#31). Verification uses the production CSS and the real component gallery, not a detached palette approximation.

Measured failures corrected during the audit (ratios shown to two decimals for reading; decisions use full precision):

| Observation | Before | After | Required |
| --- | ---: | ---: | ---: |
| Dark field boundary against its fill | 1.19 | 4.59 | 3 |
| Light search placeholder | 3.32 | 5.46 | 4.5 |
| Light selected-day token chart | 2.62 | 3.33 | 3 |
| Light failed task title on hover | 4.34 | 5.89 | 4.5 |
| Light notice metadata on hover | 4.47 | 5.54 | 4.5 |
| Dark PR filter count on selected hover | 3.98 | 7.06 | 4.5 |
| Light pending-message content/labels | 2.47 minimum observed | 5.57 (lowest pending label in light) | 4.5 |
| Working glyph at dimmest frame | 2.00 minimum observed | 3.10 minimum across both themes at the new 80% trough | 3 |

Additional fixes address the closed-PR external mark/activity, off-switch thumb, invalid fields, active warning dismiss text, sign-in action, stale/paused content and code/message fades. The original switch-audit selector briefly measured the wrong node; those harness false positives are excluded from this defect table.

Final browser runs exited **0**, with **0 computed failures, 0 axe colour-contrast violations and 0 page errors**. There are **1,106 state/scroll snapshots** and **73,407 repeated calculated observations** across both themes. The [machine-readable summary](contrast-2026-11.json) retains unrounded minima, case names and per-theme counts. A zero automated failure count is reported only alongside the manual resolutions and limitations below.

| Runner | Coverage | Snapshots | Calculated observations | Manual observations | axe incomplete nodes |
| --- | --- | ---: | ---: | ---: | ---: |
| Routes | 32 routes × 2 themes × 2 widths | 366 | 15,677 | 738 | 536 |
| Interactions | 61 states × 2 themes × 2 widths | 244 | 17,204 | 458 | 1,592 |
| Shared components | 74 snapshots × 2 themes × 2 widths | 296 | 30,762 | 492 | 9,424 |
| Narrow/zoom supplement | 5 routes × 2 themes × 320/560/800 px, CSS zoom 125% | 86 | 3,810 | 212 | 171 |
| Touch supplement | 5 routes × 2 themes × 320/400/560/800 px, coarse pointer | 94 | 5,592 | 232 | 174 |
| Live PR list supplement | Open list, mock live merge update, stale row, History and detail × 2 themes × 2 widths | 20 | 362 | 12 | 572 |

The route supplement names are Coordinator, Captain, task, identities and usage. The base 400 px run uses a fine pointer; touch is explicitly tested by the supplement. The runners retained 2,458 exemption observations (including repeated inactive controls and punctuation separators). Large incomplete counts mainly repeat offscreen gallery nodes; they are not counts of distinct failures.

| Lowest calculated ratio by kind | Light | Dark | Required |
| --- | ---: | ---: | ---: |
| Visible text | 4.71 | 4.83 | 4.5 normal / 3 large |
| Placeholder | 5.47 | 5.32 | 4.5 |
| Field boundary (inside and outside) | 3.91 | 4.59 | 3 |
| Meaningful icon, including pulse trough | 3.72 | 3.10 | 3 |
| Chart fill, full shared palette | 3.13 | 3.14 | 3 |
| Switch thumb against track | 9.26 | 9.26 | 3 |
| Selected text | 10.89 | 8.67 | 4.5 |
| Focus outline | 7.60 | 10.61 | 3 |
| Status dot against separating ring | 6.47 | 5.23 | 3 |

Primary browser evidence was captured at `7ded5dc`, including main through #31; the live PR-list supplement at `51f28a7` also covers the final filter-count adjustment. The default shared-component runner now includes that supplement; it was run separately with `ONLY='^pr-list'` during this audit. Main through #35 was subsequently merged: its only intervening web change enlarges the decorative wordmark Y without changing colour; the other changes are documentation and the SSH fixture correction. The previously observed SSH Codex-home assertion was reproduced, reported to the Captain, corrected by #35, and its focused reproduction then passed. It was not subtracted as a baseline failure.

Full raw JSON, fix-time failure records and PNGs are published with this task as `contrast-evidence-2026-11.zip` (under 25 MiB). Public screenshot links: [failed hover before](https://github.com/AgentSystemLabs/box-yard/blob/pr-assets/task_96956d74d124/failed-before.png?raw=true), [after](https://github.com/AgentSystemLabs/box-yard/blob/pr-assets/task_96956d74d124/failed-after.png?raw=true), [desktop/narrow in both themes](https://github.com/AgentSystemLabs/box-yard/blob/pr-assets/task_96956d74d124/coverage.png?raw=true), [working icons at trough](https://github.com/AgentSystemLabs/box-yard/blob/pr-assets/task_96956d74d124/dark-working-icons.png?raw=true), [PR checks](https://github.com/AgentSystemLabs/box-yard/blob/pr-assets/task_96956d74d124/pr-checks.png?raw=true), [selected usage](https://github.com/AgentSystemLabs/box-yard/blob/pr-assets/task_96956d74d124/usage-light.png?raw=true), [preview controls](https://github.com/AgentSystemLabs/box-yard/blob/pr-assets/task_96956d74d124/preview-dark.png?raw=true), [live PR update light](https://github.com/AgentSystemLabs/box-yard/blob/pr-assets/task_96956d74d124/stale-pr-light.png?raw=true), [dark](https://github.com/AgentSystemLabs/box-yard/blob/pr-assets/task_96956d74d124/stale-pr-dark.png?raw=true).


## Manual review, exemptions and limits

| Automated uncertainty | Resolution and evidence |
| --- | --- |
| Select background SVG | It is the right-hand chevron, outside the padded text area. Inspected rendered controls and SVG strokes: light #62626f on #f4f4f5 = 5.46:1; dark #a1a1aa on #18181b exceeds 6:1. The values and boundaries measured against the opaque fill pass independently. Native popup painting remains browser-owned. |
| Sticky header backdrop blur | Header supplies 95% opaque theme background. A conservative 12.75-channel shift toward the worst black/white backing leaves the recorded header text at least 5.19:1 light / 6.04:1 dark and icons at least 5.19:1 / 4.77:1. Visual review includes header chips over scrolled content. |
| Live-update Re-sort pill blur | The 95% opaque fill bounds backing colour. Applying the same worst-endpoint bound leaves all visible pill ink at least 4.90:1 light / 4.64:1 dark, including punctuation. Reviewed over the stale PR row. |
| Preview arrows over an image/checkerboard | Generated SVGs contain opposing pure-black/white halves. Resting 70% theme fill gives conservative arrow contrast 4.95:1 light / 5.21:1 dark on the worst endpoint; opaque hover and keyboard focus checked in the real gallery. The checkerboard is decorative. |
| Stacked chart adjacency | Segments have a theme-background separator border, so neighbouring hues are not their only boundary. Every shared fill is checked against the base/card/selected surface and remains at least 3:1; labelled readouts/legends and breakdown rows provide values without colour matching. |
| Tagged composer textarea | Transparent textarea overlays the visible tag/text mirror. The helper verifies equal content, then measures mirror words and selected text. Screenshots confirm one visible draft with readable selection; the transparent editing layer is not scored as readable ink. |
| axe pseudo-content / overlapping backgrounds | Enlarged tap-area pseudo-elements are transparent. Folded code has opaque nested backgrounds, no remaining fade mask, and a separate copy gutter. Their visible words, PRs, links and code are measured independently. |
| axe partially obscured/obscuring | Often repeated offscreen gallery sections or clipped scroll edges. Every section and overlapping scroll step is visited; only visible fragments enter computed measurements. Screenshot review covers the pending messages, meters, code, scroll clips and selected rows. Hidden portions are not declared a pass. |
| axe short text / non-BMP | Decorative separator punctuation is recorded as exempt beside readable labels; keyboard symbols and visible words still receive a text measurement. |

The raw evidence preserves these unresolved-by-automation categories rather than treating axe `incomplete` as an automated pass. No remaining contrast failure was found in the assessed visible fixture states after this review.


- A disabled control is exempt under 1.4.3/1.4.11 only when it is actually inactive (`:disabled` or `aria-disabled` and its interaction code refuses the action). Exemption records retain its observed ratio and reason. A pending message, paused automation, stale PR or busy usage table remains readable content and receives no such exemption.
- Native checkbox/select popup painting remains under browser control (no custom accent/appearance on checkboxes). The authored field/focus indicators and labels are checked.
- Button fills need not contrast 3:1 when readable words/icons identify the control; focus still must. See [W3C boundary guidance](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html#boundaries).
- Low-contrast panel separators, code dividers, skeleton fills and backdrop scrims are decorative. They do not identify an otherwise invisible input or carry status. Text-field outlines and switch cues are measured independently. Chart grid lines aid estimation; readable readouts and tables provide the numeric values, while bar fills are independently checked.
- Logos/wordmarks, user-provided pictures, arbitrary user HTML/PDF/media and external provider/GitHub pages have content-specific contrast outside this app-chrome audit. Preview controls remain in scope.
- This browser run does not certify every OS-native menu or browser engine. Native select popup/checkbox painting, forced colours and user styles vary. Credential-gated provider flows, real streaming infrastructure failures, and arbitrary future message content are not exhaustively enumerated; their shared visible components are covered where listed.
- Status-dot work landed during the audit (#31). After merging it, an expanded highlighted-row check found 2.90:1 task / 2.91:1 Captain glyphs at the interim 75% setting; the final 80% trough clears 3:1. Dots stay opaque: blue 7.56:1 light / 9.13:1 dark, yellow 9.07:1 / 11.55:1, red 6.47:1 / 5.23:1 against their surface ring. No dot is required on idle/done icons.

## Risk and merge validation

Assessed risk: **Medium**, because shared colours/focus/pulse affect many surfaces. Security and performance risk are low: production changes are presentational, while the browser gallery and filesystem seed require explicit development commands and mock data. Reverting the change restores prior presentation and removes the audit tooling; it does not undo published screenshots.

The required typecheck/build/fast-test gate is run after the report commit, with HEAD stable; its exact revision and results are recorded in the PR. During iteration the affected-test graph expanded through shared dependencies; an obsolete broad related run was stopped after revealing the SSH assertion above. The first final fast gate identified two assertions for the deliberately replaced opacity styles; those visual contracts were updated and their focused 30-test run passed. No full-suite or slow-tier command was used. The separate focused SSH reproduction passed after #35. Browser results above are independent of that integration correction.
