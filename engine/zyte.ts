// Zyte API client. One job: fetch a URL's raw HTML reliably.
//
// Every request goes through the same guard rails:
//   - budget stop: halts cleanly before a pay-as-you-go spend cap can kill a run
//   - pool-wide pause: a 429 or per-domain limit pauses ALL in-flight lanes,
//     because backing off one lane while the rest keep firing achieves nothing
//   - retries: rate limits retry patiently, transient bans retry briefly

const ZYTE_URL = 'https://api.zyte.com/v1/extract'
const API_KEY = Deno.env.get('ZYTE_API_KEY') ?? ''

const RATE_LIMIT_STATUSES = [429, 503]
const TRANSIENT_STATUSES = [500, 520, 521, 522, 524]
const DOMAIN_LIMIT_TYPES = ['/limits/over-domain-limit', '/limits/over-org-domain-limit']
// Zyte-reported upstream hiccups (e.g. 421 /website/connection-error when a
// single connection to eBay drops): retryable regardless of HTTP status.
const TRANSIENT_ERROR_TYPES = ['/website/connection-error', '/website/temporary-error', '/temporary-error']

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let maxRequests = 25000
let verbose = false
let pauseUntil = 0
let made = 0

export function configure(opts: { maxRequests?: number; verbose?: boolean }) {
	if (opts.maxRequests !== undefined) maxRequests = opts.maxRequests
	if (opts.verbose !== undefined) verbose = opts.verbose
}

export function requestsMade(): number {
	return made
}

export class BudgetExceeded extends Error {
	constructor() {
		super(`request budget reached (re-run to continue, or raise --max-requests)`)
	}
}

export interface FetchOptions {
	geolocation?: string // ISO country code; eBay then renders shipping for it
}

// Fetch one URL through Zyte and return its raw HTML.
export async function fetchHTML(url: string, opts: FetchOptions = {}, attempt = 1): Promise<string> {
	// Checked here rather than at module load so key-free commands (export,
	// tests) keep working without one.
	if (!API_KEY) {
		throw new Error('ZYTE_API_KEY is not set. Copy .env.example to .env and fill it in, or export it.')
	}
	if (made >= maxRequests) throw new BudgetExceeded()
	while (Date.now() < pauseUntil) await sleep(Math.min(pauseUntil - Date.now(), 1000) + 50)

	made++
	const t0 = performance.now()
	const res = await fetch(ZYTE_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: 'Basic ' + btoa(API_KEY + ':'),
		},
		body: JSON.stringify({
			url,
			httpResponseBody: true,
			...(opts.geolocation ? { geolocation: opts.geolocation } : {}),
		}),
	})
	const secs = ((performance.now() - t0) / 1000).toFixed(1)

	if (res.ok) {
		const data = await res.json()
		if (verbose) console.log(`    zyte 200 ${secs}s ${url}`)
		return atob(data.httpResponseBody ?? '')
	}

	const body = await res.text()
	let errorType = ''
	try {
		errorType = JSON.parse(body).type ?? ''
	} catch { /* non-JSON error body */ }

	const rateLimited = RATE_LIMIT_STATUSES.includes(res.status) || DOMAIN_LIMIT_TYPES.includes(errorType)
	if (rateLimited && attempt <= 8) {
		const wait = 20000 + Math.random() * 20000 // 20-40s, applied to every lane
		pauseUntil = Math.max(pauseUntil, Date.now() + wait)
		if (verbose) {
			console.log(
				`    zyte ${res.status} ${errorType || 'rate-limited'}, pool paused ${
					Math.round(wait / 1000)
				}s (try ${attempt}) ${url}`,
			)
		}
		return fetchHTML(url, opts, attempt + 1)
	}
	if ((TRANSIENT_STATUSES.includes(res.status) || TRANSIENT_ERROR_TYPES.includes(errorType)) && attempt <= 5) {
		if (verbose) {
			console.log(`    zyte ${res.status} ${errorType || 'transient'}, retry ${attempt} in ${attempt * 3}s ${url}`)
		}
		await sleep(attempt * 3000)
		return fetchHTML(url, opts, attempt + 1)
	}

	throw new Error(`Zyte returned ${res.status} ${errorType} for ${url}`)
}
