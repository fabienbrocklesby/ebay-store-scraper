// The web app: a thin layer over the proven scrape.ts CLI.
//
// Hand-rolled routing on URL.pathname (no framework), server-rendered HTML
// (views.ts), htmx polling for live status. Jobs run as subprocesses managed
// by jobs.ts; this process never imports the engine.
//
// Environment:
//   APP_PASSWORD          required. The shared password for the whole app.
//   PORT                  default 8000
//   DATA_DIR              default ./jobs (one folder per job; mount a volume here)
//   MAX_REQUESTS_PER_JOB  default 1000000 (the per-job spending safety limit)
//   SCRAPE_CONCURRENCY    default 160 (validated sweet spot, ~1.6M products/day)
//   ZYTE_API_KEY          inherited by job subprocesses; zyte.ts has a fallback

import { JobManager, type JobRecord } from './jobs.ts'
import { friendlyStatus, type JobStatus } from './progress.ts'
import { homePage, jobPage, loginPage, type StatusView, statusWrapper } from './views.ts'
import { parseStoresFile } from './validate.ts'
import { dollarsToRequests } from './money.ts'

// --- configuration ---

const APP_PASSWORD = Deno.env.get('APP_PASSWORD') ?? ''
if (!APP_PASSWORD) {
	console.error(
		'Refusing to start: the APP_PASSWORD environment variable is not set.\n' +
			'Starting a scrape spends real money, so the app must be password protected.\n' +
			'Set APP_PASSWORD to a shared password and start the server again.',
	)
	Deno.exit(1)
}

// Blank counts as unset: compose and Dokploy pass declared-but-empty env vars
// as empty strings.
if ((Deno.env.get('ZYTE_API_KEY') ?? '').trim() === '') {
	console.error(
		'Refusing to start: the ZYTE_API_KEY environment variable is not set.\n' +
			'Every scrape request authenticates with it, so jobs would all fail.\n' +
			'Copy .env.example to .env and fill it in (key from app.zyte.com).',
	)
	Deno.exit(1)
}

const PORT = Number(Deno.env.get('PORT') ?? '8000')
const DATA_DIR = Deno.env.get('DATA_DIR') ?? './jobs'
// Optional default per-run spending stop for new jobs; unset or blank means no
// limit (each job can still set its own under Technical details).
const maxRequestsRaw = Number(Deno.env.get('MAX_REQUESTS_PER_JOB') ?? '')
const MAX_REQUESTS_PER_JOB = Number.isFinite(maxRequestsRaw) && maxRequestsRaw > 0 ? maxRequestsRaw : null
const SCRAPE_CONCURRENCY = Number(Deno.env.get('SCRAPE_CONCURRENCY') ?? '160')
// Measured blended $ per 1,000 Zyte requests; converts user-facing dollar
// limits into the engine's --max-requests. Re-measure in the Zyte dashboard
// after plan changes (see TESTING.md section 5).
const COST_PER_1K_USD = Number(Deno.env.get('COST_PER_1K_USD') ?? '0.12')

const jobs = new JobManager({
	dataDir: DATA_DIR,
	scrapeScript: new URL('../engine/scrape.ts', import.meta.url).pathname,
	exportScript: new URL('../engine/export.ts', import.meta.url).pathname,
	concurrency: SCRAPE_CONCURRENCY,
	maxRequestsPerJob: MAX_REQUESTS_PER_JOB,
	// For cheap smoke tests only, e.g. SCRAPE_EXTRA_ARGS='--cap=4'. See TESTING.md.
	extraArgs: (Deno.env.get('SCRAPE_EXTRA_ARGS') ?? '').split(/\s+/).filter(Boolean),
})
jobs.init()

// --- session cookie ---
//
// One shared password, so the session is just proof of knowing it: an HMAC-style
// hash of the password under a per-boot random salt. Restarting the server logs
// everyone out, which is fine for this app.

const BOOT_SALT = crypto.randomUUID()
const SESSION_COOKIE = 'session'

async function sessionToken(): Promise<string> {
	const data = new TextEncoder().encode(`${BOOT_SALT}:${APP_PASSWORD}`)
	const digest = await crypto.subtle.digest('SHA-256', data)
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

function cookieValue(req: Request, name: string): string | null {
	const header = req.headers.get('cookie') ?? ''
	for (const part of header.split(';')) {
		const [k, ...rest] = part.trim().split('=')
		if (k === name) return rest.join('=')
	}
	return null
}

async function isAuthed(req: Request): Promise<boolean> {
	return cookieValue(req, SESSION_COOKIE) === await sessionToken()
}

const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
	new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } })

const redirect = (to: string, headers: Record<string, string> = {}) =>
	new Response(null, { status: 303, headers: { location: to, ...headers } })

// --- views glue ---

function statusView(job: JobRecord): StatusView {
	const progress = jobs.progress(job.id)
	return {
		job,
		progress,
		friendly: friendlyStatus(job.status as JobStatus, progress, jobs.queueAhead(job.id)),
		files: jobs.files(job.id),
		ratePer1k: COST_PER_1K_USD,
	}
}

function renderHome(upload?: { errors: ReturnType<typeof parseStoresFile>['errors']; fileName: string }): string {
	const rows = jobs.list().map((job) => ({
		job,
		headline: friendlyStatus(job.status as JobStatus, jobs.progress(job.id), jobs.queueAhead(job.id)).headline,
	}))
	return homePage(rows, upload)
}

// --- static files ---

const STATIC_TYPES: Record<string, string> = {
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
}

async function serveStatic(pathname: string): Promise<Response> {
	const name = pathname.replace('/static/', '')
	if (name.includes('/') || name.includes('..')) return new Response('Not found', { status: 404 })
	const ext = name.slice(name.lastIndexOf('.'))
	const type = STATIC_TYPES[ext]
	if (!type) return new Response('Not found', { status: 404 })
	try {
		const file = await Deno.open(new URL(`../static/${name}`, import.meta.url))
		return new Response(file.readable, {
			headers: { 'content-type': type, 'cache-control': 'public, max-age=3600' },
		})
	} catch {
		return new Response('Not found', { status: 404 })
	}
}

// --- handlers ---

async function handleUpload(req: Request): Promise<Response> {
	let form: FormData
	try {
		form = await req.formData()
	} catch {
		return html(renderHome({ errors: [], fileName: 'your file' }), 400)
	}
	const file = form.get('stores')
	if (!(file instanceof File)) {
		return html(renderHome({ errors: [], fileName: 'your file' }), 400)
	}

	const parsed = parseStoresFile(await file.text())
	if (parsed.errors.length > 0) {
		return html(renderHome({ errors: parsed.errors, fileName: file.name }), 400)
	}
	if (parsed.stores.length === 0) {
		return html(
			renderHome({
				errors: [{ line: 1, text: '', message: 'The file is empty. Add one eBay store per line.' }],
				fileName: file.name,
			}),
			400,
		)
	}

	const name = file.name.replace(/\.txt$/i, '') || 'Store list'
	const job = jobs.create(name, parsed.stores)
	return redirect(`/jobs/${job.id}`)
}

async function handleJobAction(req: Request, id: string, action: string): Promise<Response> {
	const job = jobs.get(id)
	if (!job) return new Response('Not found', { status: 404 })
	if (action === 'start' || action === 'resume') jobs.enqueue(id)
	if (action === 'stop') jobs.stop(id)
	if (action === 'budget') {
		// The advanced form posts a dollar figure; empty clears the limit, junk
		// leaves it unchanged.
		try {
			const form = await req.formData()
			const raw = String(form.get('budget') ?? '').trim()
			if (raw === '') {
				jobs.setBudget(id, null)
			} else {
				const requests = dollarsToRequests(Number(raw), COST_PER_1K_USD)
				if (requests > 0) jobs.setBudget(id, requests)
			}
		} catch {
			// No form body; nothing to change.
		}
	}
	return redirect(`/jobs/${id}`)
}

function handleDownload(id: string, name: string): Response {
	const path = jobs.filePath(id, name)
	if (!path) return new Response('Not found', { status: 404 })
	const file = Deno.openSync(path)
	return new Response(file.readable, {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': `attachment; filename="${name}"`,
		},
	})
}

// --- router ---

async function handler(req: Request): Promise<Response> {
	const url = new URL(req.url)
	const path = url.pathname

	if (path === '/healthz') return new Response('ok')
	if (path.startsWith('/static/') && req.method === 'GET') return serveStatic(path)

	if (path === '/login' && req.method === 'POST') {
		const form = await req.formData()
		if (form.get('password') !== APP_PASSWORD) {
			return html(loginPage('That password is not right. Please try again.'), 401)
		}
		return redirect('/', {
			'set-cookie': `${SESSION_COOKIE}=${await sessionToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`,
		})
	}
	if (path === '/logout' && req.method === 'POST') {
		return redirect('/', { 'set-cookie': `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` })
	}

	// Everything below requires the shared password.
	if (!await isAuthed(req)) return html(loginPage(), 401)

	if (path === '/' && req.method === 'GET') return html(renderHome())
	if (path === '/jobs' && req.method === 'POST') return handleUpload(req)

	const parts = path.split('/').filter(Boolean) // ['jobs', id, ...rest]
	if (parts[0] === 'jobs' && parts.length >= 2) {
		const id = parts[1]
		if (parts.length === 2 && req.method === 'GET') {
			const job = jobs.get(id)
			if (!job) return new Response('Not found', { status: 404 })
			return html(jobPage(statusView(job)))
		}
		if (parts.length === 3 && parts[2] === 'status' && req.method === 'GET') {
			const job = jobs.get(id)
			if (!job) return new Response('Not found', { status: 404 })
			return html(statusWrapper(statusView(job)))
		}
		if (parts.length === 3 && req.method === 'POST') {
			return handleJobAction(req, id, parts[2])
		}
		if (parts.length === 4 && parts[2] === 'files' && req.method === 'GET') {
			return handleDownload(id, parts[3])
		}
	}

	return new Response('Not found', { status: 404 })
}

// On shutdown, stop the running engine (if any) and mark its job interrupted
// so the page offers Resume after the restart. Hard crashes are caught by the
// orphan scan in jobs.init() instead.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
	Deno.addSignalListener(signal, () => {
		jobs.shutdown()
		Deno.exit(0)
	})
}

Deno.serve({ port: PORT }, handler)
console.log(`Jobs directory: ${DATA_DIR}`)
console.log(
	`Default per-run request budget: ${
		MAX_REQUESTS_PER_JOB === null ? 'no limit' : MAX_REQUESTS_PER_JOB.toLocaleString('en-US')
	}`,
)
