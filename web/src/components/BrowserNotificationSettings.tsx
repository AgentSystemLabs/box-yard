import { useReducer, useState, useSyncExternalStore, type ReactNode } from "react"
import { BellRing, CircleCheck, Info, ShieldAlert, type LucideIcon } from "lucide-react"
import {
  browserNotificationSupport,
  browserNotificationsOn,
  notificationPermission,
  sendTestNotification,
  setBrowserNotifications,
  subscribePermission,
  type PermissionState,
} from "../lib/browserNotifications"
import { useDraft } from "../lib/settingsDraft"
import { Row } from "./SettingsBlocks"
import { Button, LineIcon, TAP_AREA, cx } from "./ui"

type Tone = "muted" | "info" | "good" | "warn"
const TONE: Record<Tone, string> = { muted: "text-zinc-500", info: "text-sky-300", good: "text-emerald-300", warn: "text-amber-300" }
const TONE_ICON: Record<Tone, LucideIcon> = { muted: Info, info: Info, good: CircleCheck, warn: ShieldAlert }

export interface BrowserNotificationStatus {
  tone: Tone
  text: string
  /** The switch can't turn them on from here; the text says what to do instead. */
  locked: boolean
}

/**
 * What the row says under the switch: why it can't be turned on here, what Save will do (ask the browser), or that
 * they're on. `refused` means the last Save asked and didn't get permission.
 */
export function browserNotificationStatus(o: {
  support: ReturnType<typeof browserNotificationSupport>
  permission: PermissionState
  on: boolean
  saved: boolean
  refused: boolean
}): BrowserNotificationStatus | null {
  if (o.support === "insecure")
    return { tone: "muted", locked: true, text: "Browsers only allow notifications on a secure address (https or localhost). Open Box Yard that way to turn them on." }
  if (o.support === "ios-home-screen")
    return { tone: "muted", locked: true, text: "On iPhone and iPad, add Box Yard to your Home Screen first (Share, then Add to Home Screen), open it from there and turn this on." }
  if (o.support === "unsupported") return { tone: "muted", locked: true, text: "This browser doesn't support notifications." }
  if (o.permission === "denied")
    return { tone: "warn", locked: !o.on, text: "Blocked by this browser. Allow notifications for this site in the browser's site settings, then come back here." }
  if (o.permission === "default") {
    if (o.refused) return { tone: "warn", locked: false, text: "The browser didn't allow them. Turn on and Save to be asked again." }
    return o.on
      ? { tone: "info", locked: false, text: "Save asks this browser for permission. Choose Allow." }
      : { tone: "muted", locked: false, text: "Turning this on and saving asks this browser for permission." }
  }
  if (o.on && o.saved) return { tone: "good", locked: false, text: "On in this browser." }
  if (o.on) return { tone: "info", locked: false, text: "This browser allows them. Save to turn them on." }
  return null
}

/**
 * Settings › Notifications › Browser notifications. The switch is a draft like every setting; Save turns them on,
 * asking the browser for permission inside the Save click. Under it: the browser's answer as it stands now (it
 * follows changes made in the site settings) and, once on, a test.
 */
export function BrowserNotificationsRow({ fid }: { fid: (k: string) => string }) {
  const support = browserNotificationSupport()
  const permission = useSyncExternalStore(subscribePermission, notificationPermission, () => "unsupported" as const)
  // Saved means chosen in this browser and still allowed by it; re-read after a Save and on permission changes.
  const [, savedChanged] = useReducer((n: number) => n + 1, 0)
  const saved = browserNotificationsOn()
  const [refused, setRefused] = useState(false)
  const [test, setTest] = useState<"sent" | "failed" | null>(null)
  const [on, setOn] = useDraft("browser-notifications", "notifications", saved, async (want: boolean) => {
    const now = await setBrowserNotifications(want)
    savedChanged()
    setRefused(want && !now)
    setTest(null)
  })
  const status = browserNotificationStatus({ support, permission, on, saved, refused })
  const sendTest = async () => setTest((await sendTestNotification()) ? "sent" : "failed")

  return (
    <Row
      id={fid("bn")}
      label="Browser notifications"
      help="A system notification when a task needs your input, opens a PR or fails while Box Yard is in the background. It shows the task, its project and one line, never anything that looks like a key or token. In-app toasts and the sidebar's Recent list work either way."
      hint={
        status || test ? (
          <div className="w-full space-y-2" aria-live="polite">
            {status && <StatusLine tone={status.tone}>{status.text}</StatusLine>}
            {saved && on && (
              <Button type="button" size="sm" variant="subtle" onClick={() => void sendTest()} title="Show a sample notification now">
                <BellRing className="h-3.5 w-3.5" /> Send a test
              </Button>
            )}
            {test === "sent" && <StatusLine tone="muted">Sent. If nothing showed up, check that your system allows notifications from this browser.</StatusLine>}
            {test === "failed" && <StatusLine tone="warn">This browser didn't show it. Check its site settings for notifications.</StatusLine>}
          </div>
        ) : undefined
      }
    >
      <label className={cx(TAP_AREA, "flex items-center gap-2 text-sm text-zinc-200")}>
        <input
          id={fid("bn")}
          type="checkbox"
          disabled={Boolean(status?.locked)}
          checked={on}
          onChange={(e) => {
            setOn(e.target.checked)
            setRefused(false)
            setTest(null)
          }}
        />
        {on ? "On" : "Off"}
      </label>
    </Row>
  )
}

function StatusLine({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <p className={cx("flex items-start gap-1.5 text-xs leading-relaxed", TONE[tone])}>
      <LineIcon icon={TONE_ICON[tone]} className="h-3.5 w-3.5" />
      <span className="min-w-0">{children}</span>
    </p>
  )
}
