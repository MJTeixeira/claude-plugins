// The order to try a seat's candidates in. Imported by the hooks (the first pick) and by the supervisor (each
// failover), so it imports nothing from node: (bin/structure.test.mjs).

const ORDER = { reviewer: ['free', 'unknown', 'busy'], owner: ['free', 'busy', 'unknown'] }

/**
 * @typedef {import('./ledger.mjs').State} State
 * @typedef {{ state: State, family: string, firstRank?: number }} Option
 *   One candidate as it stands now, in the seat line's list order.
 */

/**
 * Pure. The candidates to try, best first, as indexes into `options`; one that is out is left out. A pinned line
 * (an explicit model, or an account) runs its first candidate. Then by state, then the job's `first` rules, then the
 * family with the fewest seats running on this machine, then list order. Percentages within a state never reorder,
 * so a reading that moves a point does not flap the order.
 * @param {readonly Option[]} options
 * @param {{ tier: 'reviewer'|'owner', pinned?: boolean, live: Readonly<Record<string, number>> }} context
 * @returns {number[]}
 */
export const rank = (options, { tier, pinned = false, live }) => {
  const order = ORDER[tier]
  const key = index => {
    const option = options[index]
    const pinnedFirst = pinned && index === 0 ? 0 : 1
    return [pinnedFirst, order.indexOf(option?.state ?? 'unknown'), option?.firstRank ?? 0, live[option?.family ?? ''] ?? 0, index]
  }
  const compare = (a, b) => {
    const [x, y] = [key(a), key(b)]
    const at = x.findIndex((value, i) => value !== y[i])
    return at === -1 ? 0 : (x[at] ?? 0) - (y[at] ?? 0)
  }
  return options.flatMap((option, index) => option.state === 'out' ? [] : [index]).sort(compare)
}
