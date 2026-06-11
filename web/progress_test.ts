import { assertEquals } from '@std/assert'
import { friendlyStatus, newProgress, parseLog, timeLeft } from './progress.ts'

const SAMPLE_RUN = `=== run started 2026-06-11T00:00:00.000Z ===
listing 112 stores (concurrency 160)
listed  alphaparts: 4810 products (35 requests)
empty   quietstore: 0 products (37 requests)
FAILED  badstore: socket hang up (will retry next run)
fetching full details for 329254 products (concurrency 160)
  12400/329254 (1120/min, 25300 requests)
`

Deno.test('parses the listing phase', () => {
	const p = parseLog(SAMPLE_RUN.split('\n').slice(0, 5).join('\n'))
	assertEquals(p.phase, 'listing')
	assertEquals(p.storesTotal, 112)
	assertEquals(p.storesChecked, 3)
	assertEquals(p.storesFailed, 1)
	assertEquals(p.productsFound, 4810)
	assertEquals(p.requestsUsed, 37)
})

Deno.test('parses the details phase and its progress ticks', () => {
	const p = parseLog(SAMPLE_RUN)
	assertEquals(p.phase, 'details')
	assertEquals(p.productsTotal, 329254)
	assertEquals(p.productsDone, 12400)
	assertEquals(p.ratePerMin, 1120)
	assertEquals(p.requestsUsed, 25300)
	assertEquals(p.budgetStop, false)
})

Deno.test('parses a budget stop and the end-of-run summary', () => {
	const p = parseLog(
		SAMPLE_RUN + `budget stop during full details: 25300 requests used, re-run to continue
Zyte requests this run: 25300
Stores:   discovered=105 empty=7
Products: listed=316854 done=12400 failed=31
Exported 329254 products to data/products_*.csv
`,
	)
	assertEquals(p.budgetStop, true)
	assertEquals(p.phase, 'finishing')
	assertEquals(p.failedProducts, 31)
	assertEquals(p.exportedProducts, 329254)
})

Deno.test('a run marker resets state, so a resumed log reflects only the latest run', () => {
	const resumed = SAMPLE_RUN +
		`budget stop during full details: 1000 requests used, re-run to continue
=== run started 2026-06-12T00:00:00.000Z ===
listing 112 stores (concurrency 160)
`
	const p = parseLog(resumed)
	assertEquals(p.budgetStop, false)
	assertEquals(p.phase, 'listing')
	assertEquals(p.productsDone, 0)
})

Deno.test('descriptions phase is recognized', () => {
	const p = parseLog('fetching 5000 descriptions (concurrency 160)\n  200/5000 (950/min, 240 requests)')
	assertEquals(p.phase, 'descriptions')
	assertEquals(p.productsTotal, 5000)
	assertEquals(p.productsDone, 200)
})

Deno.test('timeLeft humanizes durations', () => {
	assertEquals(timeLeft(500, 1000), 'less than a minute left')
	assertEquals(timeLeft(5000, 1000), 'about 5 minutes left')
	assertEquals(timeLeft(316854, 1120), 'about 5 hours left')
	assertEquals(timeLeft(3000000, 1120), 'about 2 days left')
	assertEquals(timeLeft(100, 0), '')
})

Deno.test('friendly status: queued shows queue position', () => {
	const s = friendlyStatus('queued', newProgress(), 1)
	assertEquals(s.headline, 'Waiting in line behind 1 other job.')
	const s2 = friendlyStatus('queued', newProgress(), 0)
	assertEquals(s2.headline, 'Waiting to start...')
})

Deno.test('friendly status: running details phase shows counts, percent and time left', () => {
	const s = friendlyStatus('running', parseLog(SAMPLE_RUN), 0)
	assertEquals(s.headline, 'Collecting product details: 12,400 of 329,254 (3%)')
	assertEquals(s.detail, 'about 5 hours left, collecting around 1,120 products a minute')
	assertEquals(s.percent, 3)
})

Deno.test('the run marker carries the run start time', () => {
	const p = parseLog(SAMPLE_RUN)
	assertEquals(p.runStartedAt, '2026-06-11T00:00:00.000Z')
})

Deno.test('live listing lines: checking stores and a found-so-far counter', () => {
	const p = parseLog(`listing 3 stores (concurrency 160)
checking alpha
checking bravo
checking charlie
  found 2400 products so far (12 requests)
listed  bravo: 1900 products (15 requests)
`)
	assertEquals(p.checkingStores, ['alpha', 'charlie'])
	assertEquals(p.productsFound, 2400) // live counter still ahead of completions
	assertEquals(p.completedListed, 1900)
	assertEquals(p.requestsUsed, 15)
})

Deno.test('friendly status: a single-store listing names the store and counts up', () => {
	const p = parseLog(`=== run started 2026-06-11T00:00:00.000Z ===
listing 1 stores (concurrency 160)
checking tlautopart
  found 2400 products so far (11 requests)
`)
	const s = friendlyStatus('running', p, 0)
	assertEquals(s.headline, 'Finding products in tlautopart...')
	assertEquals(s.detail, '2,400 products found so far')
})

Deno.test('friendly status: listing gains a rough step ETA once stores complete', () => {
	const s = friendlyStatus('running', parseLog(SAMPLE_RUN.split('\n').slice(0, 5).join('\n')), 0, 3)
	// 3 stores checked in 3 minutes leaves 109 stores at ~1/min
	assertEquals(s.detail.endsWith('about 2 hours left in this step'), true)
})

Deno.test('friendly status: listing phase talks about stores, not requests', () => {
	const s = friendlyStatus('running', parseLog(SAMPLE_RUN.split('\n').slice(0, 5).join('\n')), 0)
	assertEquals(s.headline, 'Finding products in 112 stores...')
	assertEquals(s.detail, '3 of 112 stores checked, 4,810 products found so far')
})

Deno.test('friendly status: budget stop is honest and resumable', () => {
	const s = friendlyStatus('stopped', newProgress(), 0)
	assertEquals(s.headline, 'Stopped at the spending safety limit.')
	assertEquals(s.canResume, true)
})

Deno.test('friendly status: done surfaces failed products without blocking completion', () => {
	const p = parseLog(
		SAMPLE_RUN + `Zyte requests this run: 660000
Products: done=329223 failed=31
Exported 329254 products to data/products_*.csv
`,
	)
	const s = friendlyStatus('done', p, 0)
	assertEquals(s.headline, 'Finished.')
	assertEquals(
		s.detail,
		'329,254 products collected. The files below are ready to download. ' +
			'1 store could not be checked and will be retried if you resume. ' +
			'31 products could not be fetched and will be retried if you resume.',
	)
	assertEquals(s.canResume, true)
})

Deno.test('friendly status: done with no failures offers no resume', () => {
	const p = parseLog(`listing 2 stores (concurrency 160)
listed  alpha: 4 products (2 requests)
fetching full details for 4 products (concurrency 160)
Zyte requests this run: 10
Products: done=4
Exported 4 products to data/products_*.csv
`)
	const s = friendlyStatus('done', p, 0)
	assertEquals(s.detail, '4 products collected. The files below are ready to download.')
	assertEquals(s.canResume, false)
})
