// A field for a secret (a token, an API key, a client secret) that browsers and password managers leave alone.
//
// A type="password" field invites autofill. Chrome, Safari and Firefox ignore autocomplete="off" on one, fill a saved
// password into it (and the text field before it, taken for a user name), and offer to save whatever was pasted as
// this site's "password", which then lands in the next secret field. So a secret field here is a text field masked
// with CSS, carries every password manager's opt-out, and takes only what the user typed, pasted, dropped or deleted:
// an autofill that slips through anyway is dropped, and React puts the field back as it was.
import type { ChangeEvent, InputHTMLAttributes } from "react"
import { cx } from "./ui"

/** Opt-outs for the browser's form history and the password managers' extensions. Spread on any field near a secret. */
export const NO_AUTOFILL = {
  autoComplete: "off",
  "data-1p-ignore": "true", // 1Password
  "data-lpignore": "true", // LastPass
  "data-bwignore": "true", // Bitwarden
  "data-form-type": "other", // Dashlane
  "data-protonpass-ignore": "true", // Proton Pass
} as const

/**
 * Whether an input event is one a person made: typing, an input method, paste, drop, cut, delete or undo all carry an
 * inputType. Autofill doesn't: Chrome and Safari fire a plain `input` event with none, Firefox (and extensions that
 * mimic it) `insertReplacementText`, and password managers dispatch a plain Event too.
 */
export function madeByUser(event: Event): boolean {
  const kind = (event as Partial<InputEvent>).inputType
  return Boolean(kind) && kind !== "insertReplacementText"
}

export type SecretInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "autoComplete"> & { value: string }

/** A masked, autofill-proof input for a secret. `onChange` hears only what the user typed or pasted. */
export function SecretInput({ value, onChange, className, ...props }: SecretInputProps) {
  const block = (e: { preventDefault: () => void }) => e.preventDefault()
  return (
    <input
      {...props}
      {...NO_AUTOFILL}
      type="text"
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      value={value}
      onChange={(e: ChangeEvent<HTMLInputElement>) => {
        if (madeByUser(e.nativeEvent)) onChange?.(e)
      }}
      // Like a password field: what's in it can't be copied out. Masked only once there's text, so the placeholder reads.
      onCopy={block}
      onCut={block}
      className={cx(className, value && "[-webkit-text-security:disc]")}
      data-secret=""
    />
  )
}
