// Turn the scraper CLI's log output into structured progress, and structured
// progress into friendly, non-developer status text.
//
// The engine (scrape.ts) prints stable, machine-parseable lines:
//
//   listing 112 stores (concurrency 160)
//   listed  somestore: 4810 products (35 requests)
//   empty   otherstore: 0 products (37 requests)
//   FAILED  badstore: <error> (will retry next run)
//   fetching 329254 descriptions (concurrency 160)
//   fetching full details for 329254 products (concurrency 160)
//     12400/329254 (1120/min, 25300 requests)
//   budget stop during full details: 1000000 requests used, re-run to continue
//   Zyte requests this run: 25300
//   Products: listed=3000 done=12400 failed=31
//   Exported 329254 products to data/products_*.csv
//
// The web server additionally writes a "=== run ... ===" marker line at the top
// of every (re)start, so a resumed job's log resets cleanly to a fresh state.
//
// Pure functions, no IO: tested in progress_test.ts.

export type Phase = 'starting' | 'listing' | 'descriptions' | 'details' | 'finishing'

export interface EngineProgress {
	phase: Phase
	storesTotal: number
	storesChecked: number // listed + empty + failed
	storesFailed: number
	productsFound: number // running total from per-store listing lines
	productsTotal: number // total of the current desc/details phase
	productsDone: number
	ratePerMin: number // products per minute, from the engine's progress line
	requestsUsed: number
	budgetStop: boolean
	exportedProducts: number | null // set once the final CSV export ran
	failedProducts: number // from the end-of-run summary
}

export function newProgress(): EngineProgress {
	return {
		phase: 'starting',
		storesTotal: 0,
		storesChecked: 0,
		storesFailed: 0,
		productsFound: 0,
		productsTotal: 0,
		productsDone: 0,
		ratePerMin: 0,
		requestsUsed: 0,
		budgetStop: false,
		exportedProducts: null,
		failedProducts: 0,
	}
}

export const RUN_MARKER_PREFIX = '=== run'

// Feed one log line into the state. Mutates and returns the state.
export function feedLine(p: EngineProgress, line: string): EngineProgress {
	let m: RegExpMatchArray | null

	// A resume re-runs every phase header, so a fresh state per run is correct.
	if (line.startsWith(RUN_MARKER_PREFIX)) {
		return Object.assign(p, newProgress())
	}

	if ((m = line.match(/^listing (\d+) stores/))) {
		p.phase = 'listing'
		p.storesTotal = Number(m[1])
		return p
	}
	if ((m = line.match(/^(listed|empty)\s+\S+: (\d+) products \((\d+) requests\)/))) {
		p.storesChecked++
		p.productsFound += Number(m[2])
		p.requestsUsed = Number(m[3])
		return p
	}
	if (line.startsWith('FAILED  ')) {
		p.storesChecked++
		p.storesFailed++
		return p
	}
	if ((m = line.match(/^fetching (\d+) descriptions/))) {
		p.phase = 'descriptions'
		p.productsTotal = Number(m[1])
		p.productsDone = 0
		return p
	}
	if ((m = line.match(/^fetching full details for (\d+) products/))) {
		p.phase = 'details'
		p.productsTotal = Number(m[1])
		p.productsDone = 0
		return p
	}
	if ((m = line.match(/^\s+(\d+)\/(\d+) \((\d+)\/min, (\d+) requests\)/))) {
		p.productsDone = Number(m[1])
		p.productsTotal = Number(m[2])
		p.ratePerMin = Number(m[3])
		p.requestsUsed = Number(m[4])
		return p
	}
	if (line.startsWith('budget stop')) {
		p.budgetStop = true
		return p
	}
	if ((m = line.match(/^Zyte requests this run: (\d+)/))) {
		p.phase = 'finishing'
		p.requestsUsed = Number(m[1])
		return p
	}
	if ((m = line.match(/^Products: (.*)$/))) {
		const failed = m[1].match(/failed=(\d+)/)
		p.failedProducts = failed ? Number(failed[1]) : 0
		return p
	}
	if ((m = line.match(/^Exported (\d+) products/))) {
		p.exportedProducts = Number(m[1])
		return p
	}
	return p
}

export function parseLog(text: string): EngineProgress {
	const p = newProgress()
	for (const line of text.split('\n')) feedLine(p, line)
	return p
}

// --- friendly status text ---

// Job lifecycle as the web app tracks it. The engine itself only knows about
// runs; everything else is server bookkeeping.
export type JobStatus = 'draft' | 'queued' | 'running' | 'interrupted' | 'stopped' | 'done' | 'failed'

export interface FriendlyStatus {
	headline: string
	detail: string // empty string when there is nothing useful to add
	percent: number | null // 0-100 for a progress bar, null when unknowable
	canResume: boolean
}

const n = (value: number) => value.toLocaleString('en-US')

// "about 5 hours left" from a remaining count and a per-minute rate.
export function timeLeft(remaining: number, perMin: number): string {
	if (perMin <= 0 || remaining <= 0) return ''
	const minutes = remaining / perMin
	if (minutes < 1) return 'less than a minute left'
	if (minutes < 90) return `about ${Math.max(1, Math.round(minutes))} minutes left`
	const hours = minutes / 60
	if (hours < 36) return `about ${Math.round(hours)} hours left`
	return `about ${Math.round(hours / 24)} days left`
}

const RESUME_NOTE = 'No work was lost: press Resume and it continues where it stopped.'

function runningStatus(p: EngineProgress): FriendlyStatus {
	switch (p.phase) {
		case 'starting':
			return { headline: 'Starting up...', detail: '', percent: null, canResume: false }
		case 'listing': {
			const checked = p.storesTotal > 0 ? `${n(p.storesChecked)} of ${n(p.storesTotal)} stores checked` : ''
			const found = p.productsFound > 0 ? `${n(p.productsFound)} products found so far` : ''
			return {
				headline: `Finding products in ${n(p.storesTotal)} stores...`,
				detail: [checked, found].filter(Boolean).join(', '),
				percent: p.storesTotal > 0 ? Math.floor((p.storesChecked / p.storesTotal) * 100) : null,
				canResume: false,
			}
		}
		case 'descriptions':
		case 'details': {
			const verb = p.phase === 'details' ? 'Collecting product details' : 'Collecting product descriptions'
			if (p.productsTotal === 0) {
				return { headline: `${verb}...`, detail: '', percent: null, canResume: false }
			}
			const pct = Math.floor((p.productsDone / p.productsTotal) * 100)
			const eta = timeLeft(p.productsTotal - p.productsDone, p.ratePerMin)
			const speed = p.ratePerMin > 0 ? `collecting around ${n(p.ratePerMin)} products a minute` : ''
			return {
				headline: `${verb}: ${n(p.productsDone)} of ${n(p.productsTotal)} (${pct}%)`,
				detail: [eta, speed].filter(Boolean).join(', '),
				percent: pct,
				canResume: false,
			}
		}
		case 'finishing':
			return {
				headline: 'Wrapping up and preparing your files...',
				detail: '',
				percent: 100,
				canResume: false,
			}
	}
}

// One sentence about products or stores that could not be fetched, or empty.
function failedNote(p: EngineProgress): string {
	const notes: string[] = []
	if (p.storesFailed > 0) {
		notes.push(
			`${n(p.storesFailed)} ${p.storesFailed === 1 ? 'store' : 'stores'} could not be checked` +
				' and will be retried if you resume.',
		)
	}
	if (p.failedProducts > 0) {
		notes.push(`${n(p.failedProducts)} products could not be fetched and will be retried if you resume.`)
	}
	return notes.join(' ')
}

export function friendlyStatus(
	status: JobStatus,
	p: EngineProgress,
	queueAhead: number,
): FriendlyStatus {
	switch (status) {
		case 'draft':
			return {
				headline: 'Ready to start.',
				detail: 'Nothing is running yet. Press Start when you are ready.',
				percent: null,
				canResume: false,
			}
		case 'queued':
			return {
				headline: queueAhead > 0
					? `Waiting in line behind ${queueAhead} other ${queueAhead === 1 ? 'job' : 'jobs'}.`
					: 'Waiting to start...',
				detail: 'It will begin automatically.',
				percent: null,
				canResume: false,
			}
		case 'running':
			return runningStatus(p)
		case 'interrupted':
			return {
				headline: 'This job was interrupted.',
				detail: RESUME_NOTE,
				percent: null,
				canResume: true,
			}
		case 'stopped':
			return {
				headline: 'Stopped at the spending safety limit.',
				detail: `Everything collected so far is saved and ready to download. ${RESUME_NOTE}`,
				percent: null,
				canResume: true,
			}
		case 'failed':
			return {
				headline: 'Something went wrong and this job stopped early.',
				detail: RESUME_NOTE,
				percent: null,
				canResume: true,
			}
		case 'done': {
			const products = p.exportedProducts ?? p.productsTotal
			return {
				headline: 'Finished.',
				detail: [
					products > 0 ? `${n(products)} products collected. The files below are ready to download.` : '',
					failedNote(p),
				].filter(Boolean).join(' '),
				percent: 100,
				canResume: p.failedProducts > 0 || p.storesFailed > 0,
			}
		}
	}
}
