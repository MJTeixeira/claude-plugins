/**
 * @typedef {{ vendor: string, model: string, effort: string, account?: string }} Candidate
 * @typedef {{ cli: string } | { family: string } | { account: string } | { model: string }} Match
 * @typedef {{ needs: readonly string[], only: readonly Match[], not: readonly Match[], first: readonly Match[], description?: string }} JobPolicy
 * @typedef {Readonly<Record<string, JobPolicy>>} Policies
 * @typedef {{ familyOf: (c: Candidate) => string, capabilities: (c: Candidate) => readonly string[], modelOf: (c: Candidate) => string }} Facts
 * @typedef {{ size: string, job: string, filter?: Match, named?: Candidate }} Want
 * @typedef {{ kind: 'ok', candidates: readonly Candidate[], firsts: readonly Match[], only: readonly Match[] } | { kind: 'empty', reason: string }} CandidateSet
 * @typedef {{ clis: readonly string[], families: readonly string[], accounts: readonly string[], sizes: readonly string[], tiers: readonly string[] }} TakenWords
 * @typedef {'image-generation'} Capability
 */

export const DEFAULT_JOB = 'default'
export const CODE_JOB = 'code'
export const SESSION_ACCOUNT = 'session'

/** @type {Policies} */
export const SHIPPED_JOBS = {
  [DEFAULT_JOB]: { needs: [], only: [], not: [], first: [] },
  [CODE_JOB]: { needs: [], only: [], not: [], first: [], description: 'writes or fixes code' },
  image: { needs: ['image-generation'], only: [], not: [], first: [], description: 'makes images' },
}

export const jobWords = policies => Object.keys(policies).filter(job => job !== DEFAULT_JOB)

const JOB_WORD = /^[a-z][a-z0-9-]*$/
const HEAD = /^([^\s()]+)\s*(?:\(([^()]*)\))?$/
const RULE = /^(only|not|first)\s+(\S+)$/

/** @param {string} word @param {TakenWords} words @returns {Match} */
const matchOf = (word, words) => words.clis.includes(word) ? { cli: word }
  : words.families.includes(word) ? { family: word }
    : word === SESSION_ACCOUNT || words.accounts.includes(word) ? { account: word }
      : { model: word }

/** @param {string} word @param {TakenWords} words */
const takenAs = (word, words) => words.sizes.includes(word) ? 'a size'
  : words.tiers.includes(word) ? 'a tier'
    : words.clis.includes(word) ? 'a CLI'
      : words.families.includes(word) ? 'a model family'
        : word === SESSION_ACCOUNT || words.accounts.includes(word) ? 'an account' : undefined

/**
 * @param {string} setting @param {TakenWords} words @returns {{ policies: Policies, problems: string[] }}
 */
export const parseJobs = (setting, words) => {
  /** @type {Record<string, JobPolicy>} */
  const policies = { ...SHIPPED_JOBS }
  const problems = []
  const set = new Set()
  for (const piece of setting.split(';')) {
    const entry = piece.trim()
    if (entry === '') continue
    const wrong = what => problems.push('The jobs entry "' + entry + '" ' + what + '.')
    const colon = entry.indexOf(':')
    const head = (colon === -1 ? entry : entry.slice(0, colon)).trim()
    if (head.includes('(') && !head.includes(')')) {
      wrong('opens a parenthesis it does not close')
      continue
    }
    const named = colon === -1 ? null : HEAD.exec(head)
    if (!named) {
      wrong('is not `<job> [(<what it is for>)]: <rule>, ...`')
      continue
    }
    const job = named[1] ?? ''
    const description = named[2]?.trim() || undefined
    const rules = entry.slice(colon + 1).split(',').map(rule => rule.trim()).filter(Boolean)
    const bad = rules.find(rule => !RULE.test(rule))
    if (!JOB_WORD.test(job)) wrong('names the job "' + job + '", which is not lower-case letters, digits and hyphens starting with a letter')
    else if (takenAs(job, words)) wrong('names the job "' + job + '", which is already ' + takenAs(job, words) + ' word')
    else if (bad !== undefined) wrong('has the rule "' + bad + '", which is not only, not or first followed by one CLI, family, account or model pattern')
    else if (rules.length === 0 && description === undefined) wrong('has no rules and no description')
    else if (set.has(job)) wrong('sets the job ' + job + ' again; its first entry is kept')
    else {
      set.add(job)
      const shipped = Object.hasOwn(SHIPPED_JOBS, job) ? SHIPPED_JOBS[job] : undefined
      const said = description ?? shipped?.description
      /** @type {{ only: Match[], not: Match[], first: Match[] }} */
      const ruled = { only: [], not: [], first: [] }
      for (const rule of rules) {
        const [, verb, word] = RULE.exec(rule) ?? []
        ruled[verb].push(matchOf(word, words))
      }
      policies[job] = { needs: shipped?.needs ?? [], ...ruled, ...(said === undefined ? {} : { description: said }) }
    }
  }
  return { policies, problems }
}

/** Whole-id and case-insensitive: `*` any run of characters, `?` one, every other character itself. */
export const globMatch = (glob, model) => new RegExp('^' + [...glob].map(char => char === '*' ? '.*' : char === '?' ? '.'
  : char.replace(/[.+^${}()|[\]\\/]/g, '\\$&')).join('') + '$', 'iu').test(model)

/** @param {Match} match */
export const matchWord = match => Object.values(match)[0]

/** @param {Match} match @param {Candidate} candidate @param {Facts} facts */
export const matches = (match, candidate, facts) => 'cli' in match ? candidate.vendor === match.cli
  : 'family' in match ? facts.familyOf(candidate) === match.family
    : 'account' in match ? (candidate.account ?? (candidate.vendor === 'claude' ? SESSION_ACCOUNT : undefined)) === match.account
      : globMatch(match.model, facts.modelOf(candidate))

const hasAll = (needs, candidate, facts) => needs.every(need => facts.capabilities(candidate).includes(need))

const wholeCliOrFamily = (candidate, candidates, needs, facts) =>
  candidates.every(other => other.vendor !== candidate.vendor || hasAll(needs, other, facts)) ? candidate.vendor : facts.familyOf(candidate)

/** @param {readonly Candidate[]} candidates @param {readonly string[]} needs @param {Facts} facts @returns {string[]} */
export const capableWords = (candidates, needs, facts) => [...new Set(candidates.filter(candidate => hasAll(needs, candidate, facts))
  .map(candidate => wholeCliOrFamily(candidate, candidates, needs, facts)))]

export const needsText = needs => needs.map(need => need.replaceAll('-', ' ')).join(' and ')

const listed = (matchList, joiner) => matchList.map(matchWord).join(joiner)

/** @param {JobPolicy} policy @returns {string[]} */
export const ruleText = policy => [
  ...(policy.only.length > 0 ? ['only on ' + listed(policy.only, ' or ')] : []),
  ...(policy.not.length > 0 ? ['never on ' + listed(policy.not, ' or ')] : []),
  ...(policy.first.length > 0 ? ['tried on ' + [matchWord(policy.first[0]) + ' first', ...policy.first.slice(1).map(matchWord)].join(', then ')] : []),
]

const NOUN = { cli: 'CLI', family: 'family', account: 'account', model: 'model' }

/** @param {string} job @param {readonly Match[]} only */
export const onlyText = (job, only) => 'job ' + job + ' runs only on ' + listed(only, ' or ')

/**
 * @param {Want} want @param {readonly Candidate[]} base @param {Policies} policies @param {Facts} facts @returns {CandidateSet}
 */
export const candidateSet = (want, base, policies, facts) => {
  const policy = policies[want.job]
  const job = 'job ' + want.job
  const { filter, named } = want
  const model = named && facts.modelOf(named)
  const empty = reason => /** @type {CandidateSet} */ ({ kind: 'empty', reason })
  const subject = filter ? 'the ' + matchWord(filter) + ' ' + NOUN[Object.keys(filter)[0]] : 'the ' + want.size + ' size'
  const kept = filter ? base.filter(candidate => matches(filter, candidate, facts)) : base
  if (kept.length === 0) {
    return empty((filter ? subject + ' has no ' + want.size + ' model' : subject + ' has no model') + ' this machine can run, so '
      + job + ' has nothing to try. Name another CLI or family, or none.')
  }
  const capable = () => {
    const words = capableWords(base, policy.needs, facts)
    return words.length > 0 ? ' Name a CLI or family that has it (' + words.join(', ') + '), or drop the job word.'
      : ' No ' + want.size + ' model this machine can run has it.'
  }
  const notMatching = candidate => policy.not.filter(match => matches(match, candidate, facts))
  const steps = [
    {
      keep: candidate => hasAll(policy.needs, candidate, facts),
      named: () => 'the line names ' + model + ', and ' + job + ' needs ' + needsText(policy.needs) + ', which it lacks.' + capable(),
      empty: () => job + ' needs ' + needsText(policy.needs) + ', and ' + subject + ' has none.' + capable(),
    },
    {
      keep: candidate => policy.only.length === 0 || policy.only.some(match => matches(match, candidate, facts)),
      named: () => 'the line names ' + model + ', which ' + job + ' does not allow (only ' + listed(policy.only, ' or ') + '). Name a model the job allows.',
      empty: () => onlyText(want.job, policy.only) + ', and ' + subject + ' has none of them. Name one of them, or change the jobs setting.',
    },
    {
      keep: candidate => notMatching(candidate).length === 0,
      named: () => 'the line names ' + model + ', which ' + job + ' excludes (' + notMatching(named).map(match => 'not ' + matchWord(match)).join(', ')
        + '). Name a model the job allows.',
      empty: () => job + ' excludes ' + listed(policy.not, ' and ') + ', which leaves ' + subject + ' nothing to try. Name another CLI or family, or change the jobs setting.',
    },
  ]
  let candidates = kept
  for (const step of steps) {
    if (named && !step.keep(named)) return empty(step.named())
    candidates = candidates.filter(step.keep)
    if (candidates.length === 0) return empty(step.empty())
  }
  return { kind: 'ok', candidates, firsts: policy.first, only: policy.only }
}

/** @param {Candidate} candidate @param {readonly Match[]} firsts @param {Facts} facts */
export const firstRank = (candidate, firsts, facts) => {
  const at = firsts.findIndex(match => matches(match, candidate, facts))
  return at === -1 ? firsts.length : at
}

export const byFirst = (candidates, firsts, facts) => [...candidates].sort((a, b) => firstRank(a, firsts, facts) - firstRank(b, firsts, facts))
