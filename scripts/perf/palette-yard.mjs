// A big, deterministic yard for the command palette benches: hundreds of projects, thousands of tasks and files.
// Shared by scripts/perf/palette-rank-bench.mjs (the ranking alone, in Node) and scripts/perf/palette-bench.mjs (the browser).

const WORDS =
  "the orchestrator box agent task branch worker snapshot preview schedule queue merge review compact context stream token session resume archive deploy commit test build lint render scroll virtual list memo cache sidebar composer markdown table code thread event status inbox palette upload attachment drop zone keyboard latency frame paint layout fix add remove dark mode settings voice usage spend runner machine harness"
    .split(" ")
// Mostly finished work; a busy yard runs a dozen tasks at once, not hundreds.
const STATUSES = ["done", "done", "done", "done", "done", "done", "idle", "idle", "pr_ready", "failed", "needs_input", "waiting"]
const ACTIVE = { working: 12, queued: 6 }
const PR_STATES = ["open", "merged", "merged", "closed", null]
const EXTS = ["png", "md", "html", "json", "csv", "txt", "pdf", "webm"]

function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** `projects` projects, `tasks` tasks and `artifacts` files, the same on every call. */
export function paletteYard({ projects = 300, tasks = 5000, artifacts = 1000, now = Date.now() } = {}) {
  const r = rng(7)
  const pick = (list) => list[Math.floor(r() * list.length)]
  const words = (min, max) => {
    const n = min + Math.floor(r() * (max - min + 1))
    const w = Array.from({ length: n }, () => pick(WORDS))
    w[0] = w[0].charAt(0).toUpperCase() + w[0].slice(1)
    return w.join(" ")
  }
  const projectList = Array.from({ length: projects }, (_, i) => {
    const name = `${pick(WORDS)}-${pick(WORDS)}-${i}`
    return {
      id: `prj_bench${String(i).padStart(4, "0")}`,
      name,
      repo: r() < 0.8 ? `acme/${name}` : null,
      description: words(4, 12),
      position: i,
      createdAt: now - 400 * 86_400_000,
      updatedAt: now - Math.floor(r() * 90 * 86_400_000),
    }
  })
  const taskList = Array.from({ length: tasks }, (_, i) => {
    const status = i < ACTIVE.working ? "working" : i < ACTIVE.working + ACTIVE.queued ? "queued" : pick(STATUSES)
    const pr = r() < 0.45
    const updatedAt = now - Math.floor(r() * 120 * 86_400_000)
    return {
      id: `task_bench${String(i).padStart(5, "0")}`,
      projectId: projectList[Math.floor(r() * projects)].id,
      title: words(3, 9),
      prompt: words(10, 30),
      status,
      boxId: null,
      sessionId: `ses_${i}`,
      branch: `branch-${i}`,
      prUrl: pr ? `https://github.com/acme/repo/pull/${1000 + i}` : null,
      prState: pr ? pick(PR_STATES) : null,
      prMergedAt: null,
      prMergedBy: null,
      previews: [],
      question: status === "needs_input" ? words(6, 14) + "?" : null,
      // Agents' closing summaries: a line to a short paragraph.
      summary: r() < 0.85 ? Array.from({ length: 1 + Math.floor(r() * 4) }, () => words(8, 20) + ".").join(" ") : null,
      activity: null,
      error: status === "failed" ? words(4, 10) : null,
      waitReason: null,
      waitBoxSize: null,
      waitFor: [],
      turnCount: 1 + Math.floor(r() * 30),
      pendingCount: 0,
      lastArchivedAt: null,
      scheduleId: null,
      outcome: null,
      contextTokens: null,
      contextWindow: null,
      compactPending: false,
      compacting: false,
      agentCli: "claude",
      model: null,
      effort: null,
      claudeCostUsd: 0,
      claudeTokens: 0,
      createdAt: updatedAt - 3_600_000,
      updatedAt,
    }
  })
  const artifactList = Array.from({ length: artifacts }, (_, i) => {
    const ext = pick(EXTS)
    const filename = `${pick(WORDS)}-${pick(WORDS)}-${i}.${ext}`
    return {
      id: `art_bench${String(i).padStart(5, "0")}`,
      projectId: r() < 0.9 ? projectList[Math.floor(r() * projects)].id : null,
      taskId: null,
      title: words(2, 6),
      filename,
      mime: ext === "png" ? "image/png" : "text/plain",
      size: 1000 + Math.floor(r() * 1e6),
      url: `/artifacts/art_bench${i}/${filename}`,
      createdAt: now - Math.floor(r() * 120 * 86_400_000),
    }
  })
  return { projects: projectList, tasks: taskList, artifacts: artifactList }
}

/** What someone types into the palette, one prefix per keystroke. */
export const QUERIES = ["review palette", "dark mode", "task_bench0421", "#1234", "shot.png"]
