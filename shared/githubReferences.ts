/** A Composer reference carries its repository and URL even when sent to another chat. */
export interface GithubReference {
  number: number
  title: string
  kind: "issue" | "pull"
  state: "open" | "closed" | "merged"
  url: string
}

export interface GithubReferenceAnswer {
  repo: string | null
  items: GithubReference[]
  problem: string | null
}
