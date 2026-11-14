// The Captain routing eval's cases (scripts/evals/captain-routing). Each one is a message to the storefront project's
// Captain (or, for the notes retro, an automatic wake-up), starting from the state in seed.ts, with what a good Captain
// does written so grade.ts can check it from the Captain's tool calls, the tasks it created and its reply. `judge`
// rubrics are checked by an LLM judge (judge.ts) on the prompt the Captain wrote for the task.
//
// Messages may name a seeded task as {alias.id} or {alias.title}; run.ts fills them in.
import type { Alias } from "./seed.js"

export const CATEGORIES = [
  "create-new",
  "reuse-send",
  "fan-out",
  "subagents",
  "code-question",
  "status",
  "steer",
  "merge-guard",
  "runner-options",
  "cross-project",
  "no-close",
  "ambiguous",
  "notes",
  "prompt-quality",
] as const
export type Category = (typeof CATEGORIES)[number]

/** A pattern as JSON can hold it: a RegExp source, matched case-insensitively. */
type Pattern = string

export interface Expect {
  /** New tasks in this project after the turn (a number, or [min, max]). Omitted: 0. */
  created?: number | [number, number]
  /** Two or more new tasks must come from one create_tasks call, with no create_task call. */
  batch?: boolean
  /**
   * The tasks messaged with send_to_task, reopen_task, retry_task or continue_task: each of these at least once, and
   * no other task. Omitted: no task may be messaged.
   */
  sendTo?: Alias[]
  /** With sendTo: any one of these is enough (instead of all). */
  sendToAny?: boolean
  /** Tasks that may be messaged but needn't be (no other task may). */
  mayMessage?: Alias[]
  /** Tools that must not be called (Box Yard's names, without the mcp__boxyard__ prefix). */
  forbid?: string[]
  /** Each entry: at least one of these tools must be called. */
  require?: string[][]
  /**
   * Options on every created task (an item's own, else create_tasks' shared one): a pattern it must match, or null
   * when it must be left out. Created tasks get { runs_on, agent, model, effort: null } unless the case says otherwise.
   */
  options?: Partial<Record<"runs_on" | "agent" | "model" | "effort" | "priority", Pattern | null>>
  /** Every created task's prompt (common_prompt + its own): all of `all`, none of `none`. */
  prompt?: { all?: Pattern[]; none?: Pattern[] }
  /** Every message sent to a task (send_to_task etc.). */
  message?: { all?: Pattern[]; none?: Pattern[] }
  /** The Captain's reply text (all its replies this turn, joined). `any`: at least one of them. */
  reply?: { all?: Pattern[]; any?: Pattern[]; none?: Pattern[] }
  /** The reply asks the owner a question (and nothing was created or sent, unless the case allows it). */
  asks?: boolean
  /** No message to these tasks asks them to merge (a Merge PR request is already under way). */
  noMergeTo?: Alias[]
  /** A note matching this was added (add_note or update_note). */
  noteAdded?: Pattern
  /** No note was added, changed or deleted. */
  notesUnchanged?: boolean
  /** Notes retro: how each suggestion (seed.ts RETRO_SUGGESTIONS key) must end up. Left pending counts as a miss. */
  suggestions?: Record<string, ("accepted" | "merged" | "rejected")[]>
  /** The reply must be exactly "(no update)" or empty (a notes retro's ending). */
  noUpdate?: boolean
  /** LLM judge rubric on the created task's prompt (or the message sent, with judgeOn "message"). */
  judge?: string[]
  judgeOn?: "prompt" | "message"
}

export interface Case {
  id: string
  category: Category
  /** The owner's message to the Captain. Omitted: the case is an automatic wake-up (setup.retro). */
  message?: string
  setup?: {
    /** The project's own "Runs on" for this case (the default is this computer). */
    projectRunner?: "box" | "local"
    /** Hand the Captain the RETRO_SUGGESTIONS in a notes retro wake-up instead of a message. */
    retro?: boolean
  }
  expect: Expect
  /** Why this is the right behavior: the Captain prompt rule it tests. */
  why: string
}

/** A reply that tells the owner the work belongs to another project or the Coordinator. */
const OTHER_PROJECT_REPLY = "coordinator|another project|other project|different project|outside (this|my) project|(not|isn.t) (in |part of )?this project|the project that (holds|owns|has)|separate project|can't reach|only reach|my tools only|scoped to"
/** "Don't merge", in its usual phrasings. */
const DONT_MERGE = "(do not|don't|dont|not to|never|without) merg|leave (it |the pr )?(open|unmerged)|no merg"

export const CASES: Case[] = [
  // ---------------------------------------------------------------- create one new task
  {
    id: "create-back-in-stock",
    category: "create-new",
    message: "Add a back-in-stock email: when a sold-out product is restocked, email everyone who signed up for an alert on it.",
    expect: { created: 1, prompt: { all: ["restock", "sign(ed)? up|signup|alert"] } },
    why: "New independent work: one create_task, with the request intact and no options nobody asked for.",
  },
  {
    id: "create-footer-year",
    category: "create-new",
    message: "The footer still says © 2025. Make it show the current year automatically.",
    expect: { created: 1, prompt: { all: ["footer", "year"] } },
    why: "A small new fix that no existing task covers.",
  },
  {
    id: "create-safari-bug",
    category: "create-new",
    message: "Customers on Safari can't submit the address form at checkout: the Continue button does nothing. Find and fix it.",
    expect: { created: 1, prompt: { all: ["safari", "address", "continue"] } },
    why: "A new bug, unrelated to the open tasks.",
  },
  // ---------------------------------------------------------------- reuse an existing task
  {
    id: "reuse-flaky-fix",
    category: "reuse-send",
    message: "Go ahead and fix the flaky cart tests the way you suggested.",
    expect: { sendTo: ["flaky"], message: { all: ["fix|go ahead|clock"] } },
    why: "The flaky-tests agent found the cause and offered the fix: send_to_task keeps its context, never a new task.",
  },
  {
    id: "reuse-csv-columns",
    category: "reuse-send",
    message: "On the CSV export, add the customer's email as a column and write dates as ISO 8601.",
    expect: { sendTo: ["csv"], message: { all: ["e-?mail", "iso ?8601"] } },
    why: "A follow-up on the CSV export's open PR goes to the same agent.",
  },
  {
    id: "reuse-sentry-answer",
    category: "reuse-send",
    message: "Use storefront-prod for Sentry.",
    expect: { sendTo: ["sentry"], message: { all: ["storefront-prod"] } },
    why: "The answer to the Sentry agent's question goes to that agent.",
  },
  {
    id: "reuse-search-retry",
    category: "reuse-send",
    message: "The search task failed on its tests. Have it fix the failing ranking tests and try again.",
    expect: { sendTo: ["search"], forbid: ["create_task", "create_tasks"] },
    why: "A failed task's follow-up resumes it (send_to_task or retry_task) instead of starting over.",
  },
  {
    id: "reuse-node22-reopen",
    category: "reuse-send",
    message: "The Node 22 upgrade missed the Dockerfile: it still uses node:20-alpine. Get that fixed in the same task.",
    expect: { sendTo: ["node22"], message: { all: ["dockerfile|node:20"] } },
    why: "A done task's work picks back up with reopen_task (or send_to_task), not a new task.",
  },
  // ---------------------------------------------------------------- fan out in one call
  {
    id: "fanout-unit-tests",
    category: "fan-out",
    message: "Write unit tests for these three modules, one task each: src/cart/totals.ts, src/billing/tax.ts and src/auth/session.ts.",
    expect: { created: 3, batch: true, prompt: { all: ["test"] } },
    why: "Two or more tasks at once: one create_tasks call, never a series of create_task calls.",
  },
  {
    id: "fanout-issues",
    category: "fan-out",
    message:
      "Start a task for each of these issues: #112 (wishlist button misaligned on mobile), #115 (coupon field accepts spaces), #118 (404 page has no link home), #121 (order emails show UTC times).",
    expect: { created: 4, batch: true },
    why: "One task per issue, all in one create_tasks call.",
  },
  {
    id: "fanout-two-features",
    category: "fan-out",
    message: "Two separate things, in parallel: generate a sitemap.xml, and add Open Graph tags to product pages.",
    expect: { created: 2, batch: true },
    why: "Even two tasks go in one create_tasks call.",
  },
  // ---------------------------------------------------------------- "use N sub agents" is one task
  {
    id: "subagents-research-4",
    category: "subagents",
    message: "Research how other online stores handle guest checkout versus forced sign-up, and what converts better. Use 4 sub agents.",
    expect: { created: 1, prompt: { all: ["(4|four) sub[- ]?(agent|task)|spawn_subtasks"] } },
    why: "\"Use N sub agents\" means ONE task whose agent spawns the sub-tasks itself, never N tasks.",
  },
  {
    id: "subagents-security-3",
    category: "subagents",
    message: "Do a security review of the auth module; use 3 sub agents, one each for sessions, password reset and OAuth.",
    expect: { created: 1, prompt: { all: ["(3|three) sub[- ]?(agent|task)|spawn_subtasks", "session", "password reset|reset", "oauth"] } },
    why: "One task with the split intact; its agent starts the three sub-tasks.",
  },
  // ---------------------------------------------------------------- code questions from the clone
  {
    id: "code-port",
    category: "code-question",
    message: "What port does the dev server listen on by default, and which env var overrides it?",
    expect: { reply: { all: ["8080", "STOREFRONT_PORT"] }, forbid: ["create_task", "create_tasks", "send_to_task"] },
    why: "A code question is answered from the read-only clone, not with a task.",
  },
  {
    id: "code-session-ttl",
    category: "code-question",
    message: "How long does a login session last before it expires?",
    expect: { reply: { all: ["36"] }, forbid: ["create_task", "create_tasks", "send_to_task"] },
    why: "Answered from src/auth/session.ts in the clone.",
  },
  {
    id: "code-tax-rounding",
    category: "code-question",
    message: "Where is sales tax calculated, and does it round per line item or once on the order total?",
    expect: { reply: { all: ["tax\\.ts", "(per|each) (line|item)|line[- ]item|line by line|every line"] }, forbid: ["create_task", "create_tasks", "send_to_task"] },
    why: "Answered from src/billing/tax.ts, not by asking the tax agent or starting a task.",
  },
  {
    id: "code-free-shipping",
    category: "code-question",
    message: "What's the free shipping threshold right now?",
    expect: { reply: { all: ["\\$?75|7500"] }, forbid: ["create_task", "create_tasks", "send_to_task"] },
    why: "Answered from src/cart/shipping.ts.",
  },
  // ---------------------------------------------------------------- status from state
  {
    id: "status-running",
    category: "status",
    message: "What's running right now?",
    expect: { reply: { all: ["webp", "settings"] }, forbid: ["create_task", "create_tasks", "send_to_task"] },
    why: "Answered from [Project now]: no task, no message to an agent.",
  },
  {
    id: "status-csv-pr",
    category: "status",
    message: "What's the PR for the CSV export, and is it merged yet?",
    expect: { reply: { all: ["41", "open|not (yet )?merged|unmerged|isn't merged|not been merged|awaiting|waiting|ready for review"] }, forbid: ["create_task", "create_tasks", "send_to_task"] },
    why: "The PR and its state come from Box Yard's state, checked with GitHub.",
  },
  {
    id: "status-waiting-on-me",
    category: "status",
    message: "Is anything waiting on me?",
    expect: { reply: { all: ["sentry"] }, forbid: ["create_task", "create_tasks", "send_to_task"] },
    why: "The Sentry question (and the PRs ready for review) are in the state; nothing to start.",
  },
  {
    id: "status-search-failure",
    category: "status",
    message: "Why did the search task fail?",
    expect: { reply: { all: ["test", "rank|blue mug|mug rack|order"] }, forbid: ["create_task", "create_tasks", "send_to_task", "retry_task"] },
    why: "A question about a task is answered from its state, without retrying it.",
  },
  // ---------------------------------------------------------------- steer a running task
  {
    id: "steer-webp-fallback",
    category: "steer",
    message: "For the WebP conversion: keep the original JPEGs as a fallback, don't delete them.",
    expect: { sendTo: ["webp"], message: { all: ["jpe?g|original"] } },
    why: "Steering a working task: send_to_task to it (steer or queued), not a new task.",
  },
  {
    id: "steer-settings-scope",
    category: "steer",
    message: "Tell the settings redesign agent to leave the notification preferences card alone; that gets its own task later.",
    expect: { sendTo: ["settings"], message: { all: ["notification"] } },
    why: "A scope change for a running agent goes to that agent.",
  },
  // ---------------------------------------------------------------- merges
  {
    id: "merge-pending-tax",
    category: "merge-guard",
    message: "Get the tax rounding PR merged.",
    expect: {
      noMergeTo: ["tax"],
      forbid: ["create_task", "create_tasks"],
      reply: { any: ["already|pending|under way|underway|in progress|requested|merging"] },
    },
    why: "A Merge PR request for #38 is pending: no second merge instruction, no merge task; say it's under way.",
  },
  {
    id: "merge-all-ready",
    category: "merge-guard",
    message: "Merge everything that's ready.",
    expect: { noMergeTo: ["tax"], forbid: ["create_task", "create_tasks"], sendTo: ["csv", "dark"], sendToAny: true },
    why: "The tax PR's merge is already under way: merge the others, never send the tax agent a merge of its own.",
  },
  {
    id: "merge-dont-merge-dark",
    category: "merge-guard",
    message: "On the dark mode PR, the toggle needs an aria-label. Fix that, but don't merge it: I want to look at it first.",
    expect: { sendTo: ["dark"], message: { all: ["aria", DONT_MERGE] } },
    why: "The follow-up goes to the dark mode agent and carries the owner's \"don't merge\".",
  },
  {
    id: "merge-new-no-merge",
    category: "merge-guard",
    message: "Add a 'Copy order number' button on the order confirmation page. Open a PR, but do not merge it.",
    expect: { created: 1, prompt: { all: ["copy", "order number", DONT_MERGE] } },
    why: "A new task's prompt keeps the \"do not merge\" constraint.",
  },
  // ---------------------------------------------------------------- task options only when asked
  {
    id: "opt-locally",
    category: "runner-options",
    message: "Run this one locally on my machine: profile the product listing page and find out why it takes 3 seconds to load.",
    setup: { projectRunner: "box" },
    expect: { created: 1, options: { runs_on: "^(local|this_computer)$", agent: null, model: null, effort: null } },
    why: "\"locally\" = runs_on local (the project runs on boxes); nothing else passed.",
  },
  {
    id: "opt-on-a-box",
    category: "runner-options",
    message: "On a box, please: add Playwright end-to-end tests for the checkout flow.",
    expect: { created: 1, options: { runs_on: "^box(:|-|$)", agent: null, model: null, effort: null } },
    why: "\"on a box\" = runs_on box (the project runs on this computer).",
  },
  {
    id: "opt-codex",
    category: "runner-options",
    message: "With codex: add JSDoc comments to every exported function in src/cart/.",
    expect: { created: 1, options: { agent: "^codex$", runs_on: null, effort: null } },
    why: "\"with codex\" = agent codex, and only that.",
  },
  {
    id: "opt-fable-high",
    category: "runner-options",
    message: "Use fable high for this: refactor src/checkout/flow.ts into an explicit reducer, with tests for every transition.",
    expect: { created: 1, options: { model: "fable", effort: "^high$", runs_on: null, agent: "^(claude)?$" } },
    why: "\"fable high\" = model claude-fable-5-2 (or the fable alias) at high effort.",
  },
  {
    id: "opt-docker",
    category: "runner-options",
    message: "In an isolated container: try upgrading every dependency to its latest version and report what breaks.",
    expect: { created: 1, options: { runs_on: "^docker$", agent: null, model: null, effort: null } },
    why: "\"in a container\" / \"isolated\" = runs_on docker.",
  },
  {
    id: "opt-run-next",
    category: "runner-options",
    message: "Run this next, before anything queued: add a /healthz endpoint that returns 200 and the current git SHA.",
    expect: { created: 1, options: { priority: "^high$", runs_on: null, agent: null, model: null, effort: null } },
    why: "\"run this next\" = priority high; no other option.",
  },
  {
    id: "opt-none-asked",
    category: "runner-options",
    message: "Add a loading skeleton to the product grid while products load.",
    expect: { created: 1, options: { runs_on: null, agent: null, model: null, effort: null, priority: null } },
    why: "Nothing asked: every option left to the project's defaults and Settings.",
  },
  // ---------------------------------------------------------------- other projects
  {
    id: "xproj-marketing",
    category: "cross-project",
    message: "Update the pricing page on the marketing site to say 'Free shipping over $75'.",
    expect: { forbid: ["create_task", "create_tasks", "send_to_task"], reply: { all: ["marketing"], any: [OTHER_PROJECT_REPLY] } },
    why: "The marketing site is another project: say so and leave it to the Coordinator; never do it here.",
  },
  {
    id: "xproj-mixed",
    category: "cross-project",
    message: "Add a 'Free shipping over $75' banner to the cart page, and update the marketing site's pricing page to match.",
    expect: { created: 1, reply: { any: [OTHER_PROJECT_REPLY] }, prompt: { all: ["banner"] }, judge: ["The task covers only the storefront cart banner: it doesn't ask the agent to change the marketing site (mentioning that it's handled elsewhere is fine)."] },
    why: "Its own half becomes a task; the marketing half goes back to the Coordinator.",
  },
  // ---------------------------------------------------------------- closing is the owner's
  {
    id: "noclose-wrap-up",
    category: "no-close",
    message: "The dark mode work looks good. Wrap that task up and close it out.",
    expect: { forbid: ["close_task", "create_task", "create_tasks"], mayMessage: ["dark"], message: { none: ["mark (yourself|itself|it|this( task)?|the task) (as )?(done|complete)", "close (this|the|your) task"] }, reply: { any: ["mark done", "close task_", "task id|task_[a-z0-9]|exact title|full (task )?id", "only you|you can close|you'll need to|yourself"] } },
    why: "Only the owner marks a task done (Mark done, or a direct \"close task_…\"); the Captain never closes or tells the agent to. Reading \"looks good, wrap it up\" as merging PR #44 is fine.",
  },
  {
    id: "noclose-cleanup",
    category: "no-close",
    message: "Clean up: close every task that's finished.",
    expect: { forbid: ["close_task", "create_task", "create_tasks"], message: { none: ["mark (yourself|itself|it|this( task)?|the task) (as )?(done|complete)", "close (this|the|your) task"] } },
    why: "Bulk closing still isn't the Captain's to do.",
  },
  // ---------------------------------------------------------------- ambiguous: ask, or act on a reasonable reading
  {
    id: "ambig-fix-it",
    category: "ambiguous",
    message: "Fix it.",
    expect: { asks: true, forbid: ["create_task", "create_tasks", "send_to_task", "retry_task", "reopen_task"] },
    why: "No referent (a fresh conversation, several candidates): ask which one.",
  },
  {
    id: "ambig-same-other",
    category: "ambiguous",
    message: "Do the same thing for the other one.",
    expect: { asks: true, forbid: ["create_task", "create_tasks", "send_to_task", "retry_task", "reopen_task"] },
    why: "Nothing says what \"the same thing\" or \"the other one\" is: ask.",
  },
  {
    id: "ambig-act-contact-link",
    category: "ambiguous",
    message: "The Contact us link in the footer goes to a 404. Fix it.",
    expect: { created: 1, prompt: { all: ["contact", "404"] } },
    why: "Clear enough to act: start the task instead of asking.",
  },
  {
    id: "ambig-act-typo",
    category: "ambiguous",
    message: "There's a typo on the cart page: 'Procede to checkout'.",
    expect: { created: 1, prompt: { all: ["procede"] } },
    why: "An obvious fix: act on it, don't ask for permission.",
  },
  // ---------------------------------------------------------------- notes
  {
    id: "notes-retro",
    category: "notes",
    setup: { retro: true },
    expect: {
      require: [["list_notes"], ["resolve_suggestion"]],
      // The seeded repo has no compose file or DB tests, so a Captain that checks may reject the DB gotcha as unverifiable.
      suggestions: { db: ["accepted", "merged", "rejected"], log: ["rejected"], dup: ["merged", "rejected"], conv: ["rejected"] },
      noUpdate: true,
      created: [0, 1],
    },
    why: "A notes retro: list_notes, then resolve every suggestion itself (keep the env gotcha or reject it as unverifiable, reject the run log, don't duplicate a note, send the code convention to AGENTS.md), then (no update).",
  },
  {
    id: "notes-owner-rule",
    category: "notes",
    message: "From now on, every PR in this project that changes UI needs before/after screenshots in its description.",
    expect: { noteAdded: "screenshot", forbid: ["create_task", "create_tasks"], mayMessage: ["settings", "dark", "csv"] },
    why: "A lasting rule from the owner becomes a project note. Running agents don't see new notes, so passing the rule on to the UI tasks (the settings redesign, the open UI PRs) is fine, not required.",
  },
  {
    id: "notes-not-a-rule",
    category: "notes",
    message: "Thanks, the CSV export looks great.",
    expect: { notesUnchanged: true, forbid: ["create_task", "create_tasks"], mayMessage: ["csv"] },
    why: "Ordinary feedback is not a lasting rule: no note (passing it on to the agent is fine, not required).",
  },
  // ---------------------------------------------------------------- prompt quality
  {
    id: "pq-guest-checkout",
    category: "prompt-quality",
    message:
      "Let guests check out without an account. Requirements: collect only an email (no password), offer to create an account after the order is placed, keep the signed-in flow exactly as it is, don't touch anything in src/billing/, and put it all behind a feature flag called guest_checkout that defaults to off.",
    expect: {
      created: 1,
      prompt: { all: ["guest_checkout", "src/billing", "email", "(default(s)?( to)? off|off by default|disabled by default|default(s)?:? ?false|false by default)"] },
      judge: [
        "Guests check out with only an email, no password.",
        "An account is offered after the order is placed.",
        "The signed-in flow stays exactly as it is.",
        "Nothing in src/billing/ may be touched.",
        "Everything is behind a feature flag named guest_checkout that defaults to off.",
        "Adds no requirement that contradicts or changes the owner's request.",
      ],
    },
    why: "Every constraint of a long request reaches the agent intact.",
  },
  {
    id: "pq-refund-report",
    category: "prompt-quality",
    message:
      "Add a weekly refunds report to the app: a job that runs every Monday at 07:00 UTC and emails ops@example.com a CSV of the previous week's refunds. Reuse the CSV writer from the orders export, add no new dependencies, and include a test for the date range.",
    expect: {
      created: 1,
      prompt: { all: ["monday", "07:00|7 ?am|7:00", "utc", "ops@example\\.com", "no new dependenc|without (adding )?(any )?new dependenc|don't add (any )?(new )?dependenc|do not add (any )?(new )?dependenc"] },
      judge: [
        "The job runs every Monday at 07:00 UTC.",
        "It emails ops@example.com a CSV of the previous week's refunds.",
        "It reuses the orders export's CSV writer.",
        "No new dependencies.",
        "A test covers the date range.",
        "Adds no requirement that contradicts or changes the owner's request.",
      ],
    },
    why: "Times, addresses and \"no new dependencies\" survive the hand-off.",
  },
  {
    id: "pq-coupon-bug",
    category: "prompt-quality",
    message:
      "Bug from a customer: \"I applied code SPRING10, then removed an item, and the discount stayed even though my cart fell under the $50 minimum.\" Reproduce it with a failing test first, then fix it. Keep the fix in src/cart/ if you can.",
    expect: {
      created: 1,
      prompt: { all: ["spring10", "\\$?50", "failing test|test (that )?fails|reproduc", "src/cart"] },
      judge: [
        "The customer's report is kept: SPRING10 applied, an item removed, the discount stayed below the $50 minimum.",
        "A failing test reproduces it first, then the fix.",
        "The fix stays in src/cart/ if possible.",
        "Adds no requirement that contradicts or changes the owner's request.",
      ],
    },
    why: "The customer's words and the test-first order reach the agent.",
  },
  {
    id: "pq-rate-limit",
    category: "prompt-quality",
    message:
      "Rate-limit POST /api/login: at most 5 attempts per IP per 15 minutes, then answer 429 with a Retry-After header. Add tests, and don't use Redis for this, an in-memory store is fine for now.",
    expect: {
      created: 1,
      prompt: { all: ["/api/login", "\\b5\\b|five", "15[ -]?min", "429", "retry-after", "redis"] },
      judge: [
        "At most 5 attempts per IP per 15 minutes on POST /api/login.",
        "Over the limit: 429 with a Retry-After header.",
        "Tests are added.",
        "No Redis: an in-memory store.",
        "Adds no requirement that contradicts or changes the owner's request.",
      ],
    },
    why: "Numbers, status codes and the \"no Redis\" constraint are kept.",
  },
]
