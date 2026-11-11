import type { ReactNode } from "react"

/** A key cap in a line of hints (the palette's footer and rows, the New task dialog's footer). */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="mr-0.5 inline-block min-w-4 rounded border border-zinc-800 bg-zinc-900 px-1 text-center font-sans text-[10px] text-zinc-400">{children}</kbd>
}
