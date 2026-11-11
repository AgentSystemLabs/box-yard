// The rendered fields are the registry: Row and SettingsField register their label, help and option
// labels in both views. No parallel list to maintain, and input/textarea values never enter the index.
import { Children, cloneElement, isValidElement, createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { settingsPath, settingsRoot, type SettingsSection } from "./settingsNav"

export interface SearchableSetting {
  id: string
  label: string
  category: SettingsSection
  keywords: string
  text: string
  options: string[]
}

export const searchWords = (query: string) => [...new Set(query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean))]
export function matchesSetting(field: SearchableSetting, words: string[]) {
  const category = settingsPath(field.category).join(" ")
  const text = `${category} ${field.label} ${field.keywords} ${field.text} ${field.options.join(" ")}`.toLocaleLowerCase()
  return words.every((word) => text.includes(word))
}

/** Aliases supplement the actual rendered labels, descriptions and options. */
function aliases(label: string, category: SettingsSection) {
  return [
    settingsRoot(category) === "runners" ? "runner provider where" : "",
    category === "agents" ? "runner where workers" : "",
    category === "voice" ? "speak speech audio tts" : "",
    /signing|signed|signature/i.test(label) ? "gpg signing signature ssh commits" : "",
    /where agents run|locally/i.test(label) ? "runner where local computer" : "",
    /model/i.test(label) ? "llm ai" : "",
    /effort/i.test(label) ? "reasoning thinking" : "",
  ].join(" ")
}

interface SearchRegistry {
  words: string[]
  fields: Record<string, SearchableSetting>
  update(id: string, field: SearchableSetting | null): void
}
const SearchContext = createContext<SearchRegistry | null>(null)
const CategoryContext = createContext<SettingsSection | null>(null)
export const useSettingsSearching = () => Boolean(useContext(SearchContext)?.words.length)
const NO_WORDS: string[] = []
/** The words being searched for, lower case; none while search is off. */
export const useSettingsSearchWords = () => useContext(SearchContext)?.words ?? NO_WORDS

export function useSettingsSearch(query: string) {
  const words = useMemo(() => searchWords(query), [query])
  const [fields, setFields] = useState<Record<string, SearchableSetting>>({})
  const update = useCallback((id: string, field: SearchableSetting | null) => {
    setFields((prev) => {
      if (JSON.stringify(prev[id] ?? null) === JSON.stringify(field)) return prev
      const next = { ...prev }
      if (field) next[id] = field
      else delete next[id]
      return next
    })
  }, [])
  const registry = useMemo(() => ({ words, fields, update }), [words, fields, update])
  const matches = Object.values(fields).filter((field) => matchesSetting(field, words))
  return { registry, matches, searching: words.length > 0 }
}

export const SettingsSearchProvider = SearchContext.Provider

export function SettingsCategory({ section, children }: { section: SettingsSection; children: ReactNode }) {
  const search = useContext(SearchContext)
  const hidden = Boolean(search?.words.length && !Object.values(search.fields).some((f) => f.category === section && matchesSetting(f, search.words)))
  return <CategoryContext.Provider value={section}><div data-settings-category={section} hidden={hidden}>{children}</div></CategoryContext.Provider>
}

// The text on show: rendered labels and help, never input or textarea values. A closed select's options are indexed apart.
function textOf(root: HTMLElement): string {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const texts: string[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest("textarea, script, style, option, [data-settings-search-ignore]")) texts.push(node.textContent ?? "")
  }
  return texts.join("")
}

export function SettingsField({ label, keywords = "", children, className, as: Element = "div" }: { label: string; keywords?: string; children: ReactNode; className?: string; as?: "div" | "li" }) {
  const search = useContext(SearchContext)
  const category = useContext(CategoryContext)
  const id = useId()
  const ref = useRef<HTMLDivElement>(null)
  const update = search?.update
  useLayoutEffect(() => {
    if (!update || !category || !ref.current) return
    const root = ref.current
    const index = () => {
      const lists = [...root.querySelectorAll("input[list]")].map((input) => root.ownerDocument.getElementById(input.getAttribute("list")!)).filter((el) => el?.tagName === "DATALIST")
      // Suggestions may live outside the field (the shared Codex model list does).
      for (const list of lists) observer.observe(list!, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["label", "value"] })
      const options = [...root.querySelectorAll("option, [role=radio]"), ...lists.flatMap((list) => [...list!.querySelectorAll("option")])]
      update(id, {
        id, category, label, keywords: `${keywords} ${aliases(label, category)}`,
        text: textOf(root),
        options: options.map((o) => o.getAttribute("aria-label") ?? o.getAttribute("label") ?? (o.textContent?.trim() || o.getAttribute("value") || "")),
      })
    }
    const observer = new MutationObserver(index)
    index()
    observer.observe(root, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["aria-label", "label", "list"] })
    return () => observer.disconnect()
  }, [id, category, label, keywords, update])
  useEffect(() => () => update?.(id, null), [id, update])
  const field = search?.fields[id]
  const hidden = Boolean(search?.words.length && field && !matchesSetting(field, search.words))
  // Words the label and help already highlight need no second line: only a match hidden in a closed select gets one.
  const shown = field ? `${field.label} ${field.text}`.toLocaleLowerCase() : ""
  const unseen = field ? (search?.words ?? []).filter((w) => !shown.includes(w)) : []
  const options = unseen.length ? field!.options.filter((option) => unseen.some((w) => option.toLocaleLowerCase().includes(w))) : []
  const keywordMatches = unseen.filter((w) => field!.keywords.toLocaleLowerCase().includes(w) && !options.some((option) => option.toLocaleLowerCase().includes(w)))
  return (
    <Element ref={ref as never} data-settings-field={category ? id : undefined} data-settings-label={label} hidden={hidden} className={className}>
      {highlightSettingsText(children)}
      {options.length > 0 && <p data-settings-search-ignore className="mt-2 text-xs text-yard-300">Matching options: <SearchHighlight text={options.slice(0, 6).join(" · ")} />{options.length > 6 && ` · +${options.length - 6} more`}</p>}
      {keywordMatches.length > 0 && <p data-settings-search-ignore className="mt-2 text-xs text-zinc-400">Keywords: <SearchHighlight text={keywordMatches.join(" · ")} /></p>}
    </Element>
  )
}

/** React owns the highlights, so editing and clearing never replace a control or its draft. */
export function SearchHighlight({ text }: { text: string }) {
  const words = useContext(SearchContext)?.words ?? []
  if (!words.length) return <>{text}</>
  const pattern = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length).join("|")
  const parts = text.split(new RegExp(`(${pattern})`, "ig"))
  if (parts.length === 1) return <>{text}</>
  // One element, so a flex row (a checkbox's label) keeps the sentence together: bare, each piece is an item of its own.
  return <span className="min-w-0">{parts.map((part, i) => words.some((w) => w === part.toLocaleLowerCase()) ? <mark key={i} className="rounded bg-yard-400/25 text-yard-50">{part}</mark> : part)}</span>
}

/** Highlight help fragments and intrinsic child labels; custom controls keep their own rendering. */
export function highlightSettingsText(node: ReactNode): ReactNode {
  if (typeof node === "string") return <SearchHighlight text={node} />
  if (isValidElement<{ children?: ReactNode }>(node) && !["option", "textarea", "select"].includes(String(node.type)) && node.props.children !== undefined) {
    return cloneElement(node, {}, Children.map(node.props.children, highlightSettingsText))
  }
  return node
}
