/** Tiny test registry: no framework, no dependencies, works under plain Node or Electron-as-Node. */
const cases = []

/**
 * Register one test case.
 *
 * @param {string} name - case name.
 * @param {() => Promise<void> | void} fn - test body; throw to fail.
 */
export function test(name, fn) {
  cases.push({ name, fn })
}

/**
 * Forget every registered case, so one script can drive several sections
 * without re-running earlier ones.
 */
export function reset() {
  cases.length = 0
}

/**
 * Run registered cases, printing a TAP-ish line per case.
 *
 * @param {{ filter?: string, timeoutMs?: number, quiet?: boolean }} [options] - selection and limits.
 * @returns {Promise<{ total: number, failed: number, failures: string[], durationMs: number }>} the summary.
 */
export async function runAll(options = {}) {
  const filter = options.filter ?? ''
  const timeoutMs = options.timeoutMs ?? 180000
  const selected = cases.filter((entry) => entry.name.includes(filter))
  const failures = []
  const started = Date.now()
  for (const entry of selected) {
    const caseStarted = Date.now()
    try {
      await withTimeout(entry.fn(), timeoutMs, entry.name)
      if (options.quiet !== true) console.log(`ok   ${entry.name} (${Date.now() - caseStarted} ms)`)
    } catch (error) {
      failures.push(entry.name)
      console.log(`FAIL ${entry.name} (${Date.now() - caseStarted} ms)`)
      console.log(indent(error instanceof Error ? error.stack ?? error.message : String(error)))
    }
  }
  return { total: selected.length, failed: failures.length, failures, durationMs: Date.now() - started }
}

/** Reject a case that runs past its deadline. */
function withTimeout(promise, timeoutMs, name) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`test timed out after ${timeoutMs} ms: ${name}`)), timeoutMs)
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** Indent multi-line output so a stack trace reads as one block. */
function indent(text) {
  return String(text).split('\n').map((line) => `     ${line}`).join('\n')
}
