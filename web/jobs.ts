// Job management: one folder per job under DATA_DIR, the scrape engine spawned
// as a subprocess per run, and a strictly one-at-a-time FIFO queue.
//
// The engine (scrape.ts) is never imported here. Each job gets its own working
// directory, so the engine's relative paths (data/scrape.db, data/stores_all.txt,
// data/products_*.csv) land inside the job folder. Killing a job, restarting the
// server, or hitting the budget stop never loses work: re-spawning the same CLI
// in the same folder resumes exactly where it left off.

import { type EngineProgress, type JobStatus, parseLog, RUN_MARKER_PREFIX } from './progress.ts'
import { shipOption } from './countries.ts'

export interface JobRecord {
	id: string
	name: string
	storeCount: number
	status: JobStatus
	statusReason: string | null // shown to the user for interrupted/failed jobs
	createdAt: string
	startedAt: string | null
	finishedAt: string | null
	pid: number | null
	maxRequests: number | null // per-run spending stop in requests; null = no limit
	concurrency: number | null // parallel requests; null = server default
	shipTo: string | null // destination country code; null = no shipping data
}

export interface JobFile {
	name: string
	bytes: number
}

export interface JobsConfig {
	dataDir: string
	scrapeScript: string // absolute path to scrape.ts
	exportScript: string // absolute path to export.ts
	concurrency: number
	maxRequestsPerJob: number | null // default limit for new jobs; null = none
	includeDescriptions: boolean // fetch seller descriptions (2nd request/product)
	extraArgs?: string[] // extra engine flags, e.g. ['--cap=4'] for cheap smoke tests
}

// The engine requires a --max-requests value, so "no limit" is a number no
// real job reaches (1B requests is about $120k).
const UNLIMITED_REQUESTS = 1_000_000_000

function newJobId(): string {
	const t = new Date().toISOString().slice(0, 19).replaceAll(/[-:T]/g, '').replace(/^(\d{8})/, '$1-')
	const rand = Array.from(
		crypto.getRandomValues(new Uint8Array(3)),
		(b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31],
	).join('')
	return `${t}-${rand}`
}

export class JobManager {
	private children = new Map<string, Deno.ChildProcess>()
	private userStopped = new Set<string>()
	private pendingRestart = new Set<string>()
	private shuttingDown = false

	constructor(private config: JobsConfig) {}

	// Scan DATA_DIR on boot. Any job that claims to be running was orphaned by a
	// server restart (its subprocess died with the old server): mark it
	// interrupted so the page can offer Resume. Queued jobs stay queued and the
	// queue starts moving again immediately, since their owners already pressed
	// Start.
	init() {
		Deno.mkdirSync(this.config.dataDir, { recursive: true })
		for (const job of this.list()) {
			if (job.status === 'running') {
				this.save({
					...job,
					status: 'interrupted',
					statusReason: 'The server restarted while this job was running.',
					pid: null,
				})
				// The dead run never reached its CSV export; rebuild the files from
				// the database so everything collected so far is downloadable.
				this.refreshCSVs(job.id)
			}
		}
		this.tick()
	}

	private jobDir(id: string): string {
		return `${this.config.dataDir}/${id}`
	}

	private jobPath(id: string): string {
		return `${this.jobDir(id)}/job.json`
	}

	logPath(id: string): string {
		return `${this.jobDir(id)}/run.log`
	}

	private save(job: JobRecord) {
		Deno.writeTextFileSync(this.jobPath(job.id), JSON.stringify(job, null, '\t'))
	}

	get(id: string): JobRecord | null {
		try {
			return JSON.parse(Deno.readTextFileSync(this.jobPath(id))) as JobRecord
		} catch {
			return null
		}
	}

	list(): JobRecord[] {
		const jobs: JobRecord[] = []
		for (const entry of Deno.readDirSync(this.config.dataDir)) {
			if (!entry.isDirectory) continue
			const job = this.get(entry.name)
			if (job) jobs.push(job)
		}
		return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
	}

	// Create a job folder in 'draft' state: stores file written, nothing running,
	// nothing spent. The user starts it explicitly from the job page.
	create(name: string, storeURLs: string[]): JobRecord {
		const job: JobRecord = {
			id: newJobId(),
			name: name.trim() || 'Untitled job',
			storeCount: storeURLs.length,
			status: 'draft',
			statusReason: null,
			createdAt: new Date().toISOString(),
			startedAt: null,
			finishedAt: null,
			pid: null,
			maxRequests: this.config.maxRequestsPerJob,
			concurrency: null,
			shipTo: null,
		}
		Deno.mkdirSync(`${this.jobDir(job.id)}/data`, { recursive: true })
		Deno.writeTextFileSync(`${this.jobDir(job.id)}/data/stores_all.txt`, storeURLs.join('\n') + '\n')
		this.save(job)
		return job
	}

	// Start (from draft) or resume (from interrupted/stopped/failed/done-with-
	// failures). Both just mean: put it in the queue.
	enqueue(id: string): JobRecord | null {
		const job = this.get(id)
		if (!job) return null
		if (job.status === 'running' || job.status === 'queued') return job
		const queued: JobRecord = { ...job, status: 'queued', statusReason: null, finishedAt: null }
		this.save(queued)
		this.tick()
		return this.get(id)
	}

	// Update job settings (spending stop, speed, destination). They take
	// effect on the next run; a run already in flight keeps what it started with.
	update(id: string, patch: Partial<Pick<JobRecord, 'maxRequests' | 'concurrency' | 'shipTo'>>): JobRecord | null {
		const job = this.get(id)
		if (!job) return null
		this.save({ ...job, ...patch })
		return this.get(id)
	}

	// Stop a running job. The engine saves continuously, so this is always safe.
	stop(id: string): JobRecord | null {
		const job = this.get(id)
		if (!job || job.status !== 'running') return job
		const child = this.children.get(id)
		if (child) {
			this.userStopped.add(id)
			try {
				child.kill('SIGTERM')
			} catch {
				// Already exited; the exit handler finishes the bookkeeping.
			}
		}
		return job
	}

	// Apply new settings to a running job: kill the run and let it re-queue
	// itself. The engine resumes from its database, so nothing is redone.
	restart(id: string) {
		const job = this.get(id)
		if (!job || job.status !== 'running') return
		const child = this.children.get(id)
		if (!child) return
		this.pendingRestart.add(id)
		try {
			child.kill('SIGTERM')
		} catch {
			this.pendingRestart.delete(id)
		}
	}

	// Remove a job folder entirely. Running jobs must be stopped first, and
	// finished jobs are kept (their CSVs are the deliverable).
	delete(id: string): boolean {
		const job = this.get(id)
		if (!job || job.status === 'running' || job.status === 'done') return false
		Deno.removeSync(this.jobDir(id), { recursive: true })
		this.tick()
		return true
	}

	// How many queued jobs are ahead of this one (plus a running one, if any).
	queueAhead(id: string): number {
		const job = this.get(id)
		if (!job || job.status !== 'queued') return 0
		let ahead = 0
		for (const other of this.list()) {
			if (other.id === id) continue
			if (other.status === 'running') ahead++
			if (other.status === 'queued' && other.createdAt < job.createdAt) ahead++
		}
		return ahead
	}

	progress(id: string): EngineProgress {
		try {
			return parseLog(Deno.readTextFileSync(this.logPath(id)))
		} catch {
			return parseLog('')
		}
	}

	files(id: string): JobFile[] {
		const files: JobFile[] = []
		try {
			for (const entry of Deno.readDirSync(`${this.jobDir(id)}/data`)) {
				if (entry.isFile && /^products_\d+\.csv$/.test(entry.name)) {
					const stat = Deno.statSync(`${this.jobDir(id)}/data/${entry.name}`)
					files.push({ name: entry.name, bytes: stat.size })
				}
			}
		} catch {
			// No data dir yet.
		}
		return files.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
	}

	filePath(id: string, name: string): string | null {
		if (!/^products_\d+\.csv$/.test(name)) return null
		const path = `${this.jobDir(id)}/data/${name}`
		try {
			Deno.statSync(path)
			return path
		} catch {
			return null
		}
	}

	// If nothing is running or starting, start the oldest queued job.
	private starting = false

	private tick() {
		if (this.starting) return
		const jobs = this.list()
		if (jobs.some((j) => j.status === 'running')) return
		const next = jobs.filter((j) => j.status === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
		if (!next) return
		this.starting = true
		this.spawn(next)
			.catch((err) => {
				try {
					this.save({
						...next,
						status: 'failed',
						statusReason: `The job could not start: ${(err as Error).message}`,
						pid: null,
					})
				} catch {
					// The job folder was deleted mid-start; nothing left to record.
				}
			})
			.finally(() => {
				this.starting = false
			})
	}

	// Fresh exchange rates for a job that converts currency: one free API call,
	// cached server-wide so a flaky rates API never blocks a job.
	private async ensureFxRates(job: JobRecord, currency: string): Promise<boolean> {
		const fxPath = `${this.jobDir(job.id)}/data/fx.json`
		const cachePath = `${this.config.dataDir}/fx-cache.json`
		try {
			const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(10000) })
			const data = await res.json()
			if (data?.rates?.[currency]) {
				const fx = JSON.stringify({ base: 'USD', rates: data.rates })
				Deno.writeTextFileSync(fxPath, fx)
				Deno.writeTextFileSync(cachePath, fx)
				return true
			}
		} catch {
			// Fall through to the cache.
		}
		try {
			Deno.copyFileSync(cachePath, fxPath)
			return true
		} catch {
			return false
		}
	}

	private async spawn(job: JobRecord) {
		const dest = shipOption(job.shipTo)
		// Without rates the job still runs and collects shipping data; only the
		// currency conversion is skipped (prices stay as listed).
		const haveFx = dest ? await this.ensureFxRates(job, dest.currency) : false

		const log = Deno.openSync(this.logPath(job.id), { create: true, append: true })
		log.writeSync(new TextEncoder().encode(`${RUN_MARKER_PREFIX} started ${new Date().toISOString()} ===\n`))

		const child = new Deno.Command(Deno.execPath(), {
			args: [
				'run',
				'--allow-net',
				'--allow-read',
				'--allow-write',
				'--allow-env',
				this.config.scrapeScript,
				'--full',
				...(this.config.includeDescriptions ? [] : ['--no-desc']),
				`--concurrency=${job.concurrency ?? this.config.concurrency}`,
				`--max-requests=${job.maxRequests ?? UNLIMITED_REQUESTS}`,
				...(dest ? [`--ship-to=${dest.code}`] : []),
				...(dest && haveFx ? [`--convert-to=${dest.currency}`] : []),
				...(this.config.extraArgs ?? []),
			],
			cwd: this.jobDir(job.id),
			stdin: 'null',
			stdout: 'piped',
			stderr: 'piped',
		}).spawn()

		this.children.set(job.id, child)
		this.save({
			...job,
			status: 'running',
			statusReason: null,
			startedAt: job.startedAt ?? new Date().toISOString(),
			pid: child.pid,
		})

		// Pump both output streams into the log file; close it when both end.
		const pump = async (stream: ReadableStream<Uint8Array>) => {
			for await (const chunk of stream) log.writeSync(chunk)
		}
		const output = Promise.allSettled([pump(child.stdout), pump(child.stderr)])

		child.status.then(async (status) => {
			await output
			log.close()
			this.children.delete(job.id)
			this.finish(job.id, status.success)
		})
	}

	// Rebuild a job's products_*.csv from its database without scraping (free,
	// no network). Fire and forget: the polled job page picks the files up a
	// few seconds later.
	private refreshCSVs(id: string) {
		new Deno.Command(Deno.execPath(), {
			args: ['run', '--allow-read', '--allow-write', '--allow-env', this.config.exportScript],
			cwd: this.jobDir(id),
			stdin: 'null',
			stdout: 'null',
			stderr: 'null',
		}).spawn()
	}

	// Graceful shutdown: kill any running engine and record the interruption so
	// the job page can offer Resume after the restart. The engine saves its work
	// continuously, so SIGTERM loses nothing.
	shutdown() {
		this.shuttingDown = true
		for (const [id, child] of this.children) {
			const job = this.get(id)
			if (job) {
				this.save({
					...job,
					status: 'interrupted',
					statusReason: 'The server restarted while this job was running.',
					pid: null,
				})
			}
			try {
				child.kill('SIGTERM')
			} catch {
				// Already gone.
			}
		}
		this.children.clear()
	}

	// Classify how a run ended and let the queue move on.
	private finish(id: string, exitOk: boolean) {
		if (this.shuttingDown) return // shutdown() already recorded the interruption
		const job = this.get(id)
		if (!job) return
		const wasRestart = this.pendingRestart.delete(id)
		const wasStopped = this.userStopped.delete(id)
		const progress = this.progress(id)

		let status: JobStatus
		let reason: string | null = null
		if (wasRestart) {
			// A settings change on a live job: straight back into the queue so it
			// relaunches with the new settings.
			status = 'queued'
		} else if (wasStopped) {
			status = 'interrupted'
			reason = 'You stopped this job.'
		} else if (progress.budgetStop) {
			status = 'stopped'
		} else if (exitOk && progress.storesFailed > 0 && (progress.exportedProducts ?? 0) === 0) {
			// The engine exits cleanly even when every store errored. An "all
			// failed, nothing collected" run is not a finished job.
			status = 'failed'
			reason = 'None of the stores could be checked.'
		} else if (exitOk) {
			status = 'done'
		} else {
			status = 'failed'
		}

		this.save({ ...job, status, statusReason: reason, finishedAt: new Date().toISOString(), pid: null })
		// A run that ended early (user stop, kill, crash) never reached the
		// engine's own CSV export; rebuild the files so progress so far is
		// downloadable. Budget stops and clean finishes already exported.
		if (status === 'interrupted' || status === 'failed') this.refreshCSVs(id)
		this.tick()
	}
}
