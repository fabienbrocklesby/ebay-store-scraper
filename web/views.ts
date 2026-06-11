// Server-rendered HTML. Template-literal functions only: no template engine,
// no client framework. htmx (vendored in static/) polls the job status
// fragment; everything else is plain forms and links.

import type { LineError } from './validate.ts'
import type { JobFile, JobRecord } from './jobs.ts'
import type { EngineProgress, FriendlyStatus } from './progress.ts'
import { formatDollars, requestsToDollars } from './money.ts'

export function escapeHTML(s: string): string {
	return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

const e = escapeHTML

function layout(title: string, body: string): string {
	return `<!doctype html>
<html lang="en" class="h-full">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<meta name="robots" content="noindex">
	<title>${e(title)}</title>
	<link rel="stylesheet" href="/static/styles.css">
	<script src="/static/htmx.min.js" defer></script>
	<script>
		// The job status is re-rendered on every poll, which would snap the
		// disclosures shut; carry each one's open state across swaps.
		document.addEventListener('htmx:beforeSwap', function () {
			window.__open = Array.prototype.map.call(
				document.querySelectorAll('#status details'),
				function (d) { return d.open },
			)
		})
		document.addEventListener('htmx:afterSwap', function () {
			var ds = document.querySelectorAll('#status details')
			;(window.__open || []).forEach(function (open, i) {
				if (open && ds[i]) ds[i].setAttribute('open', '')
			})
		})
	</script>
</head>
<body class="h-full bg-stone-100 text-stone-900 antialiased">
	<div class="mx-auto max-w-3xl px-4 py-10">
		<header class="mb-8 flex items-baseline justify-between">
			<a href="/" class="text-xl font-semibold tracking-tight">eBay Store Scraper</a>
			<form method="post" action="/logout"><button class="text-sm text-stone-500 hover:text-stone-800">Log out</button></form>
		</header>
		${body}
	</div>
</body>
</html>`
}

export function loginPage(error?: string): string {
	const body = `
	<div class="mx-auto mt-16 max-w-sm rounded-xl bg-white p-8 shadow-sm">
		<h1 class="mb-1 text-lg font-semibold">Welcome</h1>
		<p class="mb-6 text-sm text-stone-500">Enter the shared password to continue.</p>
		${error ? `<p class="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">${e(error)}</p>` : ''}
		<form method="post" action="/login" class="space-y-4">
			<input type="password" name="password" required autofocus placeholder="Password"
				class="w-full rounded-lg border border-stone-300 px-3 py-2 focus:border-stone-500 focus:outline-none">
			<button class="w-full rounded-lg bg-stone-900 px-4 py-2 font-medium text-white hover:bg-stone-700">Log in</button>
		</form>
	</div>`
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Log in</title><link rel="stylesheet" href="/static/styles.css"></head>
<body class="min-h-full bg-stone-100 text-stone-900 antialiased">${body}</body></html>`
}

const STATUS_BADGE: Record<string, string> = {
	draft: 'bg-stone-200 text-stone-700',
	queued: 'bg-amber-100 text-amber-800',
	running: 'bg-blue-100 text-blue-800',
	interrupted: 'bg-orange-100 text-orange-800',
	stopped: 'bg-orange-100 text-orange-800',
	failed: 'bg-red-100 text-red-800',
	done: 'bg-green-100 text-green-800',
}

const STATUS_LABEL: Record<string, string> = {
	draft: 'Ready to start',
	queued: 'Waiting in line',
	running: 'Running',
	interrupted: 'Paused',
	stopped: 'Paused at safety limit',
	failed: 'Needs attention',
	done: 'Finished',
}

function badge(status: string): string {
	return `<span class="rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_BADGE[status] ?? ''}">${
		STATUS_LABEL[status] ?? status
	}</span>`
}

export function homePage(
	jobs: Array<{ job: JobRecord; headline: string }>,
	upload?: { errors: LineError[]; fileName: string },
): string {
	const errorBlock = upload && upload.errors.length > 0
		? `<div class="mt-4 rounded-lg bg-red-50 p-4">
			<p class="mb-2 text-sm font-medium text-red-800">
				We could not use <span class="font-semibold">${e(upload.fileName)}</span> yet.
				Please fix ${upload.errors.length === 1 ? 'this line' : 'these lines'} and upload it again:
			</p>
			<ul class="space-y-1 text-sm text-red-700">
				${upload.errors.slice(0, 20).map((err) => `<li>${e(err.message)}</li>`).join('\n')}
				${upload.errors.length > 20 ? `<li>...and ${upload.errors.length - 20} more.</li>` : ''}
			</ul>
		</div>`
		: ''

	const jobRows = jobs.length === 0
		? `<p class="py-6 text-center text-sm text-stone-500">No jobs yet. Upload a store list above to get going.</p>`
		: jobs.map(({ job, headline }) => `
		<a href="/jobs/${e(job.id)}" class="flex items-center justify-between gap-4 rounded-lg px-4 py-3 hover:bg-stone-50">
			<div class="min-w-0">
				<p class="truncate font-medium">${e(job.name)}</p>
				<p class="truncate text-sm text-stone-500">${e(headline)}</p>
			</div>
			<div class="flex shrink-0 items-center gap-3">
				<span class="text-sm text-stone-400">${job.storeCount} stores</span>
				${badge(job.status)}
			</div>
		</a>`).join('\n')

	return layout(
		'eBay Store Scraper',
		`
	<section class="rounded-xl bg-white p-6 shadow-sm">
		<h1 class="text-lg font-semibold">Start a new scrape</h1>
		<p class="mt-1 text-sm text-stone-500">
			Upload a plain text file with one eBay store per line, like
			<code class="rounded bg-stone-100 px-1.5 py-0.5">https://www.ebay.com/str/storename</code>.
			We check the file first; nothing starts until you press Start.
		</p>
		<form method="post" action="/jobs" enctype="multipart/form-data" class="mt-4 flex flex-wrap items-center gap-3">
			<input type="file" name="stores" accept=".txt,text/plain" required
				class="text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-stone-900 file:px-4 file:py-2 file:font-medium file:text-white hover:file:bg-stone-700">
			<button class="rounded-lg border border-stone-300 px-4 py-2 text-sm font-medium hover:bg-stone-50">Upload and check</button>
		</form>
		${errorBlock}
	</section>

	<section class="mt-8 rounded-xl bg-white py-3 shadow-sm">
		<h2 class="px-4 pb-1 pt-2 text-sm font-semibold uppercase tracking-wide text-stone-400">Jobs</h2>
		<div class="divide-y divide-stone-100">${jobRows}</div>
	</section>`,
	)
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
	return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export interface StatusView {
	job: JobRecord
	friendly: FriendlyStatus
	progress: EngineProgress
	files: JobFile[]
	ratePer1k: number // measured $ per 1,000 requests, for user-facing figures
	duplicatesNote?: string
}

// The optional per-run spending limit, tucked away under Technical details.
// Most jobs run with no limit; this is the advanced escape hatch.
function budgetForm(v: StatusView): string {
	const dollars = v.job.maxRequests === null
		? ''
		: String(Math.max(1, Math.round(requestsToDollars(v.job.maxRequests, v.ratePer1k))))
	return `<details class="mt-3">
		<summary class="cursor-pointer select-none">Advanced: spending limit</summary>
		<form method="post" action="/jobs/${e(v.job.id)}/budget" class="mt-2 flex flex-wrap items-center gap-2">
			<label for="budget">Pause each run after it spends about</label>
			<span class="flex items-center gap-1">$<input id="budget" name="budget" type="number" min="1" step="1"
				value="${dollars}" placeholder="no limit"
				class="w-24 rounded border border-stone-300 px-2 py-1 text-stone-700 focus:border-stone-500 focus:outline-none"></span>
			<button class="rounded border border-stone-300 px-3 py-1 font-medium text-stone-600 hover:bg-stone-50">Save</button>
		</form>
		<p class="mt-1">
			Leave the box empty for no limit. Takes effect the next time the job starts or resumes;
			a paused job keeps everything it collected and can always be resumed.
		</p>
	</details>`
}

// The live part of the job page: polled by htmx every few seconds.
export function statusFragment(v: StatusView): string {
	const { job, friendly, progress, files } = v

	const running = job.status === 'running'
	const bar = friendly.percent !== null
		? `<div class="mt-4 h-2 w-full overflow-hidden rounded-full bg-stone-100">
			<div class="h-full rounded-full bg-stone-900 transition-all duration-700${running ? ' animate-pulse' : ''}"
				style="width: ${Math.max(friendly.percent, running ? 2 : 0)}%"></div>
		</div>`
		: running
		? `<div class="mt-4 h-2 w-full animate-pulse rounded-full bg-stone-200"></div>`
		: ''

	const buttons: string[] = []
	if (job.status === 'draft') {
		buttons.push(`<form method="post" action="/jobs/${e(job.id)}/start">
			<button class="rounded-lg bg-stone-900 px-5 py-2 font-medium text-white hover:bg-stone-700">Start</button>
		</form>`)
	}
	if (friendly.canResume) {
		buttons.push(`<form method="post" action="/jobs/${e(job.id)}/resume">
			<button class="rounded-lg bg-stone-900 px-5 py-2 font-medium text-white hover:bg-stone-700">Resume</button>
		</form>`)
	}
	if (job.status === 'running') {
		buttons.push(`<form method="post" action="/jobs/${e(job.id)}/stop">
			<button class="rounded-lg border border-stone-300 px-5 py-2 font-medium text-stone-700 hover:bg-stone-50">Stop</button>
		</form>`)
	}

	const fileList = files.length > 0
		? `<div class="mt-6 border-t border-stone-100 pt-4">
			<h2 class="text-sm font-semibold uppercase tracking-wide text-stone-400">Your files</h2>
			${
			job.status !== 'done'
				? `<p class="mt-1 text-xs text-stone-400">
					These update each time the job pauses or finishes. Products the job has not
					reached yet appear with just the basics (name, price, link, one photo);
					resume the job to fill in the rest.
				</p>`
				: ''
		}
			<ul class="mt-2 space-y-1">
				${
			files.map((f) =>
				`<li>
					<a href="/jobs/${e(job.id)}/files/${e(f.name)}"
						class="flex items-center justify-between rounded-lg px-3 py-2 hover:bg-stone-50">
						<span class="font-medium text-stone-800">${e(f.name)}</span>
						<span class="text-sm text-stone-400">${formatBytes(f.bytes)} &middot; Download</span>
					</a>
				</li>`
			).join('\n')
		}
			</ul>
		</div>`
		: ''

	const reason = job.statusReason ? `<p class="mt-1 text-sm text-stone-500">${e(job.statusReason)}</p>` : ''
	const dupNote = v.duplicatesNote ? `<p class="mt-1 text-sm text-stone-500">${e(v.duplicatesNote)}</p>` : ''

	const limit = job.maxRequests === null
		? 'none'
		: `~${formatDollars(requestsToDollars(job.maxRequests, v.ratePer1k))} per run`
	const details = `<details class="mt-6 text-xs text-stone-400">
		<summary class="cursor-pointer select-none">Technical details</summary>
		<dl class="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
			<dt>Spent this run</dt><dd>~${formatDollars(requestsToDollars(progress.requestsUsed, v.ratePer1k))}</dd>
			<dt>Requests used</dt><dd>${progress.requestsUsed.toLocaleString('en-US')}</dd>
			<dt>Spending limit</dt><dd>${limit}</dd>
			<dt>Speed</dt><dd>${
		progress.ratePerMin > 0 ? `${progress.ratePerMin.toLocaleString('en-US')} products/min` : 'n/a'
	}</dd>
			<dt>Job ID</dt><dd>${e(job.id)}</dd>
		</dl>
		${budgetForm(v)}
	</details>`

	const spinner = running
		? `<span class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-stone-300 border-t-stone-900" aria-hidden="true"></span>`
		: ''

	return `
	<div class="flex items-start justify-between gap-4">
		<div>
			<div class="flex items-center gap-3">${badge(job.status)}${spinner}</div>
			<h1 class="mt-3 text-xl font-semibold">${e(friendly.headline)}</h1>
			${friendly.detail ? `<p class="mt-1 text-stone-600">${e(friendly.detail)}</p>` : ''}
			${reason}
			${dupNote}
		</div>
		<div class="flex shrink-0 gap-2 pt-1">${buttons.join('\n')}</div>
	</div>
	${bar}
	${fileList}
	${details}`
}

// The polled wrapper. While the job can still change on its own it carries the
// htmx polling attributes; once it settles, the returned wrapper has none and
// polling stops by itself (the endpoint swaps the whole div via outerHTML).
export function statusWrapper(v: StatusView): string {
	const live = v.job.status === 'running' || v.job.status === 'queued'
	const poll = live ? ` hx-get="/jobs/${e(v.job.id)}/status" hx-trigger="every 2s" hx-swap="outerHTML"` : ''
	return `<div id="status"${poll}>${statusFragment(v)}</div>`
}

export function jobPage(v: StatusView): string {
	return layout(
		`${v.job.name}`,
		`
	<p class="mb-3 text-sm text-stone-500"><a href="/" class="hover:text-stone-800">&larr; All jobs</a></p>
	<section class="rounded-xl bg-white p-6 shadow-sm">
		<p class="mb-1 text-sm text-stone-400">${e(v.job.name)} &middot; ${v.job.storeCount} stores</p>
		${statusWrapper(v)}
	</section>
	<p class="mt-4 text-center text-sm text-stone-400">
		You can close this page anytime: the job keeps running on the server.
		Come back to this address to check on it.
	</p>`,
	)
}
