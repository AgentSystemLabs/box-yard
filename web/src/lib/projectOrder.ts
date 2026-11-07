// The owner's project order, saved on the server (PUT /api/projects/order). The event stream applies a new one to
// the cached projects (lib/stream.ts).

/** `list` in the order of `ids`. Items `ids` doesn't name keep their relative order, after the named ones. */
export function applyOrder<T extends { id: string }>(list: T[], ids: readonly string[]): T[] {
  const rank = new Map(ids.map((id, i) => [id, i]))
  const at = (item: T, i: number) => rank.get(item.id) ?? ids.length + i
  return list
    .map((item, i) => ({ item, at: at(item, i) }))
    .sort((a, b) => a.at - b.at)
    .map((x) => x.item)
}

/** Same ids in the same order. */
export const sameOrder = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i])
