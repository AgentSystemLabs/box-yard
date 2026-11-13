// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { act, createElement, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { SecretInput, madeByUser } from "../web/src/components/SecretInput.js"

// A secret field (a token, an API key) is no password field, so browsers neither fill a saved password in nor offer to
// save a pasted token as one, and it takes only what a person typed, pasted, dropped or deleted: an autofill that
// slips through is dropped and the field goes back as it was.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let heard: string[]

function Field() {
  const [value, setValue] = useState("")
  return createElement(SecretInput, {
    value,
    onChange: (e) => {
      heard.push(e.target.value)
      setValue(e.target.value)
    },
    placeholder: "ghp_…",
    "aria-label": "Token",
  })
}

const input = () => host.querySelector("input")!
const fill = (value: string, event: Event) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value)
    input().dispatchEvent(event)
  })
const by = (inputType: string) => new InputEvent("input", { bubbles: true, inputType })

beforeEach(() => {
  heard = []
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(createElement(Field)))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe("SecretInput", () => {
  it("is a masked text field that opts out of autofill and every password manager", () => {
    const el = input()
    expect(el.type).toBe("text")
    expect(el.autocomplete).toBe("off")
    expect(el.getAttribute("spellcheck")).toBe("false")
    expect(el.getAttribute("autocapitalize")).toBe("off")
    expect(el.matches("[data-secret]")).toBe(true)
    expect(el.dataset).toMatchObject({ "1pIgnore": "true", lpignore: "true", bwignore: "true", formType: "other", protonpassIgnore: "true" })
    // The placeholder reads until there's a value to hide.
    expect(el.className).not.toContain("text-security")
    fill("ghp_typed", by("insertText"))
    expect(input().className).toContain("[-webkit-text-security:disc]")
  })

  it("takes typing, paste, drop and delete, and drops autofill's plain or replacement input events", () => {
    fill("ghp_one", by("insertText"))
    fill("ghp_one2", by("insertFromPaste"))
    fill("ghp_one23", by("insertFromDrop"))
    fill("ghp_one2", by("deleteContentBackward"))
    expect(heard).toEqual(["ghp_one", "ghp_one2", "ghp_one23", "ghp_one2"])

    fill("saved-site-password", new Event("input", { bubbles: true })) // Chrome, Safari, most password managers
    fill("saved-site-password", by("insertReplacementText")) // Firefox
    fill("saved-site-password", by(""))
    expect(heard).toEqual(["ghp_one", "ghp_one2", "ghp_one23", "ghp_one2"])
    expect(input().value).toBe("ghp_one2")
  })

  it("can't be copied or cut out, like a password field", () => {
    fill("ghp_secret", by("insertFromPaste"))
    for (const type of ["copy", "cut"]) {
      const e = new Event(type, { bubbles: true, cancelable: true })
      act(() => void input().dispatchEvent(e))
      expect(e.defaultPrevented).toBe(true)
    }
  })

  it("madeByUser reads only the event, so it works for any field", () => {
    expect(madeByUser(by("insertText"))).toBe(true)
    expect(madeByUser(by("insertCompositionText"))).toBe(true)
    expect(madeByUser(by("historyUndo"))).toBe(true)
    expect(madeByUser(new Event("input"))).toBe(false)
    expect(madeByUser(by("insertReplacementText"))).toBe(false)
  })
})
