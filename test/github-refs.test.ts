// "PR #406", "#12", "owner/repo#5" and "head 5f3a9c1e" in rendered text link to the repo the text is about
// (lib/linkify.ts splitGithubRefs, remarkEntityLinks' repo), and stay plain text when that repo is unknown.
import { describe, expect, it } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { buildEntityIndex, githubRepo, inferRepo, MENTIONS, remarkEntityLinks, repoOf, splitGithubRefs, type RepoScope } from "../web/src/lib/linkify.js"
import type { Project, Task } from "../shared/types.js"

const REPO = "acme/box-yard"
const GH = `https://github.com/${REPO}`

/** The links splitGithubRefs finds, as [text, url]. */
const refs = (text: string, repo: string | null = REPO) => splitGithubRefs(text, repo).flatMap((s) => (s.url ? [[s.text, s.url]] : []))

describe("splitGithubRefs", () => {
  it("links PR numbers to /pull and bare numbers to /issues", () => {
    expect(refs("PR #406 merged clean with level3-epic")).toEqual([["PR #406", `${GH}/pull/406`]])
    expect(refs("PR#7, pull request #8, Pull Request #9 and PRs #10")).toEqual([
      ["PR#7", `${GH}/pull/7`],
      ["pull request #8", `${GH}/pull/8`],
      ["Pull Request #9", `${GH}/pull/9`],
      ["PRs #10", `${GH}/pull/10`],
    ])
    expect(refs("Fixes #12.")).toEqual([["#12", `${GH}/issues/12`]])
  })

  it("keeps the text around a reference, punctuation included", () => {
    const parts = splitGithubRefs("(#12), #13; #14: [#15] “#16” #17!", REPO)
    expect(parts.map((p) => p.text).join("")).toBe("(#12), #13; #14: [#15] “#16” #17!")
    expect(parts.filter((p) => p.url).map((p) => p.text)).toEqual(["#12", "#13", "#14", "#15", "#16", "#17"])
    expect(splitGithubRefs("no refs here", REPO)).toEqual([{ text: "no refs here" }])
  })

  it("links an explicit owner/repo#N to that repo, even when the text is about another", () => {
    expect(refs("see vercel/next.js#123", REPO)).toEqual([["vercel/next.js#123", "https://github.com/vercel/next.js/issues/123"]])
    expect(refs("see vercel/next.js#123", null)).toEqual([["vercel/next.js#123", "https://github.com/vercel/next.js/issues/123"]])
    // A path or URL that happens to end in "#12" isn't one.
    expect(refs("open src/a.ts/x#12 or www/foo#3", null)).toEqual([])
  })

  it("leaves numbers plain when the repo is unknown or ambiguous", () => {
    expect(refs("PR #406 merged as 5f3a9c1e, fixes #12", null)).toEqual([])
  })

  it("links full PR and issue URLs without a repo, preserving destinations and surrounding punctuation", () => {
    const text = "See (https://github.com/a/b/pull/12/files#diff-1), https://www.github.com/c/d/issues/34?x=1."
    const parts = splitGithubRefs(text, null)
    expect(parts.map((p) => p.text).join("")).toBe(text)
    expect(parts.filter((p) => p.url)).toEqual([
      { text: "https://github.com/a/b/pull/12/files#diff-1", url: "https://github.com/a/b/pull/12/files#diff-1", kind: "pull", label: "PR #12" },
      { text: "https://www.github.com/c/d/issues/34?x=1", url: "https://www.github.com/c/d/issues/34?x=1", kind: "issue", label: "c/d#34" },
    ])
  })

  it("never links look-alike hosts, invalid paths, or references inside an unrelated URL", () => {
    expect(refs("https://evilgithub.com/a/b/pull/12 https://github.com.evil/a/b/issues/12 https://github.com/a/b/pull/12abc https://docs.test/a/b#123 https://docs.test/?q=a/b#12")).toEqual([])
  })

  it("leaves hex colours, anchors and numbers glued to words alone", () => {
    expect(refs("#fff #0f0 #000 #012 #abc #123abc #12-x")).toEqual([])
    expect(refs("color: #123456, background #333, fill=#222")).toEqual([])
    expect(refs("C#1 page#12 /#12 &#123 a-#5 ##")).toEqual([])
    // Up to 7 digits: bigger is a hex colour or an id, not a PR.
    expect(refs("#1234567 #12345678")).toEqual([["#1234567", `${GH}/issues/1234567`]])
  })

  it("links a commit SHA after head, commit, as or squash", () => {
    expect(refs("was pushed (head 5f3a9c1e).")).toEqual([["5f3a9c1e", `${GH}/commit/5f3a9c1e`]])
    expect(refs("commit 1a2b3c4d5e and squash-merged as 9f8e7d6, HEAD: abc1234")).toEqual([
      ["1a2b3c4d5e", `${GH}/commit/1a2b3c4d5e`],
      ["9f8e7d6", `${GH}/commit/9f8e7d6`],
      ["abc1234", `${GH}/commit/abc1234`],
    ])
  })

  it("reads a whole SHA as its short form, keeping the whole one in the link", () => {
    const sha = "ff8fc2305ab9c31e61cfc78f89fadf6c2d5d42ee"
    const [, seg] = splitGithubRefs(`merged as squash commit ${sha}.`, "o/r")
    expect(seg).toEqual({ text: sha, label: "ff8fc23", url: `https://github.com/o/r/commit/${sha}`, kind: "commit" })
  })

  it("leaves hex that isn't a SHA after one of those words alone", () => {
    // Words and numbers: a SHA has letters and digits.
    expect(refs("head deadbeef, as 1234567, commit facade1x")).toEqual([])
    // No keyword, too short, too long.
    expect(refs("the 5f3a9c1e build, head 8269e8, head " + "a1".repeat(21))).toEqual([])
  })
})

describe("githubRepo", () => {
  it("reads owner/repo from the forms a project's repo comes in", () => {
    expect(githubRepo("acme/box-yard")).toBe(REPO)
    expect(githubRepo("https://github.com/acme/box-yard.git")).toBe(REPO)
    expect(githubRepo("https://www.github.com/acme/box-yard/")).toBe(REPO)
    expect(githubRepo("git@github.com:acme/box-yard.git")).toBe(REPO)
    expect(githubRepo("https://gitlab.com/acme/box-yard")).toBeNull()
    expect(githubRepo("/home/cody/code/box-yard")).toBeNull()
    expect(githubRepo(null)).toBeNull()
  })
})

const projects = [
  { id: "prj_boxyard", name: "box-yard", repo: REPO },
  { id: "prj_castle", name: "keep-the-castle", repo: "https://github.com/acme/keep-the-castle" },
  { id: "prj_weather", name: "weather", repo: "acme/weather" },
  { id: "prj_notesss", name: "notes", repo: null },
] as Project[]
const tasks = [
  { id: "task_cave0406", projectId: "prj_castle", title: "Level 3 PR #406: Cave supply route", status: "done" },
  { id: "task_linkify0001", projectId: "prj_boxyard", title: "Linkify references", status: "working" },
  { id: "task_notes00001", projectId: "prj_notesss", title: "Notes cleanup", status: "idle" },
] as Task[]
const index = buildEntityIndex({ tasks, projects })

function render(md: string, repo: RepoScope) {
  return renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, [remarkEntityLinks, index, repo]] }, md))
}
const anchors = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g)].map((m) => [m[2], m[1]])

describe("GitHub references in markdown", () => {
  it("links the screenshot's notice to its task's repo", () => {
    const html = render("is done: PR #406 merged clean with level3-epic and was pushed (head 5f3a9c1e).", "acme/keep-the-castle")
    expect(anchors(html)).toEqual([
      ["PR #406", "https://github.com/acme/keep-the-castle/pull/406"],
      ["5f3a9c1e", "https://github.com/acme/keep-the-castle/commit/5f3a9c1e"],
    ])
    expect(html).toContain('data-github="pull"')
  })

  it("leaves code spans and code blocks alone", () => {
    expect(anchors(render("Run `gh pr view #12` then `git show head 5f3a9c1e`.", REPO))).toEqual([])
    expect(anchors(render("```\nPR #12 merged as 5f3a9c1e\n```", REPO))).toEqual([])
    expect(anchors(render("    indented #12", REPO))).toEqual([])
  })

  it("leaves text already in a link alone, autolinked URLs included", () => {
    expect(anchors(render("[PR #12 and #13](https://example.com)", REPO))).toEqual([["PR #12 and #13", "https://example.com"]])
    expect(anchors(render("See https://example.com/docs#12 now", REPO))).toEqual([["https://example.com/docs#12", "https://example.com/docs#12"]])
    // A bold task title is one link to the task, "PR #406" in it included.
    expect(anchors(render("**Level 3 PR #406: Cave supply route** is done", "acme/keep-the-castle"))).toEqual([
      ["<strong>Level 3 PR #406: Cave supply route</strong>", "/tasks/task_cave0406"],
    ])
  })

  it("links inside emphasis, lists, headings and tables", () => {
    const html = render("## Fixes #1\n\n- *merged #2*\n\n| PR | state |\n| --- | --- |\n| PR #3 | open |", REPO)
    expect(anchors(html).map((a) => a[0])).toEqual(["#1", "#2", "PR #3"])
  })

  it("leaves bare numbers plain without a repo, but still links owner/repo#N", () => {
    expect(anchors(render("PR #406 and acme/box-yard#12", null))).toEqual([["acme/box-yard#12", `${GH}/issues/12`]])
  })
})

describe("Coordinator replies (MENTIONS)", () => {
  it("links a paragraph's numbers to the one repo its tasks are in", () => {
    const html = render("task_cave0406 is done: PR #406 merged (head 5f3a9c1e).", MENTIONS)
    expect(anchors(html).slice(1)).toEqual([
      ["PR #406", "https://github.com/acme/keep-the-castle/pull/406"],
      ["5f3a9c1e", "https://github.com/acme/keep-the-castle/commit/5f3a9c1e"],
    ])
  })

  it("works each paragraph or list item out on its own", () => {
    const html = render("- **Level 3 PR #406: Cave supply route**: PR #406 merged\n- task_linkify0001 opened PR #180\n\nAnd #7 is next.", MENTIONS)
    expect(anchors(html).filter(([, href]) => href!.startsWith("https://"))).toEqual([
      ["PR #406", "https://github.com/acme/keep-the-castle/pull/406"],
      ["PR #180", `${GH}/pull/180`],
    ])
  })

  it("leaves a paragraph that spans projects, or names none, plain", () => {
    expect(anchors(render("task_cave0406 and task_linkify0001 both merged: #406, #180.", MENTIONS)).length).toBe(2)
    expect(anchors(render("PR #406 merged.", MENTIONS))).toEqual([])
  })

  it("lets a distinctive project name pick the repo, and a plain-word one only rule one out", () => {
    expect(anchors(render("box-yard PR #178 merged.", MENTIONS))).toEqual([["PR #178", `${GH}/pull/178`]])
    expect(anchors(render("PR #12 improves weather checks.", MENTIONS))).toEqual([])
    expect(anchors(render("task_linkify0001 fixes weather checks in PR #12.", MENTIONS)).length).toBe(1)
    expect(anchors(render("keep-the-castle and box-yard: PR #12.", MENTIONS))).toEqual([])
  })
})

describe("inferRepo and repoOf", () => {
  it("names the repo of a task or project", () => {
    expect(repoOf("task_cave0406", null, index)).toBe("acme/keep-the-castle")
    expect(repoOf("task_gone000000", "prj_boxyard", index)).toBe(REPO)
    expect(repoOf("task_notes00001", null, index)).toBeNull()
    expect(repoOf(null, null, index)).toBeNull()
  })

  it("ignores entities without a repo", () => {
    const refs = [index.byId.get("task_notes00001")!, index.byId.get("task_linkify0001")!]
    expect(inferRepo(refs, "", index)).toBe(REPO)
  })
})
