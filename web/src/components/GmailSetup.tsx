// The Gmail preset's setup in Settings › Connectors (docs/connectors.md › Gmail): the Google Cloud steps that give
// whoever runs Box Yard their own OAuth client, and a place to drop, pick or paste the client_secret….json Google
// downloads. Box Yard ships no Google client: each install signs in with its owner's.
import { useState } from "react"
import { FileJson } from "lucide-react"
import { parseGoogleClientFile } from "../../../shared/connectorPresets"
import { NewTabLink, cx, inputClass } from "./ui"

const CONSOLE = "https://console.cloud.google.com"

/** The steps, in the Google Cloud console's own words. Generic: they work for anyone, on their own Google account. */
export function GmailGuide({ open }: { open: boolean }) {
  const link = (href: string, label: string) => (
    <NewTabLink href={href} className="text-sky-300 underline-offset-2 hover:underline">
      {label}
    </NewTabLink>
  )
  return (
    <details open={open} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs leading-relaxed text-zinc-300" data-gmail-guide>
      <summary className="flex min-h-11 cursor-pointer items-center font-medium text-zinc-200 sm:min-h-0">Set up your Google OAuth client (once, about 10 minutes)</summary>
      <p className="mt-2 text-zinc-400">Box Yard doesn't come with a Google client: you make your own, free, in your Google account. It only ever signs in to your mailbox.</p>
      <ol className="mt-2 list-decimal space-y-2 pl-5 marker:text-zinc-500">
        <li>
          In the {link(`${CONSOLE}/projectcreate`, "Google Cloud console")}, create a project (or pick one of yours).
        </li>
        <li>
          Enable the {link(`${CONSOLE}/apis/library/gmail.googleapis.com`, "Gmail API")} for it.
        </li>
        <li>
          Open {link(`${CONSOLE}/auth/overview`, "Google Auth Platform")} and press <b>Get started</b>: an app name, your email as support email, Audience <b>External</b>, your email as contact.
          The app name can't contain "Google" or "Gmail" (try "My Mail Helper").
        </li>
        <li>
          On {link(`${CONSOLE}/auth/branding`, "Branding")}, fill in an <b>app homepage</b> and a <b>privacy policy</b> link as well. Any address on a site you control works: your GitHub
          profile, a repo, a gist or your own site. Google only reviews them if you submit the app for verification, which you don't need.
        </li>
        <li>
          On {link(`${CONSOLE}/auth/audience`, "Audience")}, press <b>Publish app</b> to move it to <b>In production</b>. Left in Testing, Google expires the sign-in after 7 days. Publishing
          needs the Branding fields above.
        </li>
        <li>
          On {link(`${CONSOLE}/auth/clients`, "Clients")}, <b>Create client</b> with Application type <b>Desktop app</b> (any name), then <b>Download JSON</b>.
        </li>
        <li>Drop that client_secret….json below (or pick or paste it), and press Save.</li>
        <li>
          Press <b>Sign in</b>. Google says it hasn't verified the app, since it's your own: choose <b>Advanced</b>, then <b>Go to</b> your app, and allow reading mail and managing drafts.
        </li>
        <li>
          Press <b>Test</b>: it lists the Gmail tools. No tool sends mail: drafts wait in Gmail for you.
        </li>
      </ol>
    </details>
  )
}

/** A Google client file, dropped, picked or pasted: its id and secret go into the draft, sent on Save. */
export function GoogleClientFile({ id, onClient }: { id: string; onClient: (c: { clientId: string; clientSecret: string | null; kind: "desktop" | "web" }, from: string) => void }) {
  const [error, setError] = useState<string | null>(null)
  const [over, setOver] = useState(false)
  const [paste, setPaste] = useState(false)
  const [text, setText] = useState("")
  const read = (body: string, from: string) => {
    const c = parseGoogleClientFile(body)
    if (!c) return setError(`${from} isn't a Google OAuth client file: it's the JSON that Clients › Download JSON saves (client_secret_….json).`)
    setError(null)
    setText("")
    setPaste(false)
    onClient(c, from)
  }
  return (
    <div className="space-y-2">
      <div
        className={cx("flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-xs", over ? "border-yard-500 bg-yard-500/10" : "border-zinc-700")}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={async (e) => {
          e.preventDefault()
          setOver(false)
          const file = e.dataTransfer.files?.[0]
          if (file) read(await file.text(), file.name)
        }}
        data-gmail-client-drop
      >
        <label className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-2 font-medium text-zinc-200 hover:bg-zinc-700 sm:min-h-0 sm:py-1">
          <FileJson className="h-3.5 w-3.5" /> Choose client_secret….json
          <input
            id={id}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={async (e) => {
              const file = e.target.files?.[0]
              e.target.value = ""
              if (file) read(await file.text(), file.name)
            }}
            data-testid="gmail-client-file"
          />
        </label>
        <span className="hidden text-zinc-500 sm:inline">or drop it here, or</span>
        <button type="button" className="min-h-11 px-1 text-zinc-300 underline underline-offset-2 sm:min-h-0" onClick={() => setPaste(!paste)} aria-expanded={paste}>
          paste its contents
        </button>
      </div>
      {paste && (
        <div className="space-y-2">
          <textarea
            className={cx(inputClass, "min-h-24 font-mono text-xs")}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'{"installed":{"client_id":"…","client_secret":"…",…}}'}
            aria-label="The client file's contents"
            spellCheck={false}
            autoComplete="off"
            data-testid="gmail-client-paste"
          />
          <button
            type="button"
            className="inline-flex min-h-11 items-center rounded-lg bg-zinc-800 px-3 text-xs font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-50 sm:min-h-8"
            disabled={!text.trim()}
            onClick={() => read(text, "That text")}
            data-testid="gmail-client-paste-use"
          >
            Use it
          </button>
        </div>
      )}
      {error && <p className="text-xs text-red-300">{error}</p>}
    </div>
  )
}
