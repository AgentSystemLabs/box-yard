import fs from "node:fs"

/** Notes as a prompt shows them: one "- (author) content" item per note, continuation lines kept with it. */
export function readNotes(file: string): { author: string; content: string }[] {
  const notes: { author: string; content: string }[] = []
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^- \(([^)]+)\) ([\s\S]*)$/.exec(line)
    if (m) notes.push({ author: m[1]!, content: m[2]! })
    else if (line.trim() && notes.length) notes[notes.length - 1]!.content += `\n${line}`
  }
  return notes
}
