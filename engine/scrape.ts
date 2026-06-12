// Scrape every product from every store in data/stores_all.txt into CSV.
//
// Three levels of data, each one a flag, each resumable through SQLite:
//
//   (default)    listing pass. Walks each seller's search results at 240
//                items/page and saves title, price, currency, image, URL for
//                every product. ~1 request per 240 products. Pennies.
//   --desc       + the seller's full description, from eBay's lightly-guarded
//                description host. 1 cheap raw request per product.
//   --full       + everything: item specifics (brand, MPN, fitment...), stock,
//                all gallery images, description. 2 raw requests per product.
//
// No AI extraction anywhere: every page is fetched as raw HTML and parsed by
// the code in parse.ts. Re-running always resumes; nothing is ever lost.

// deno-lint-ignore-file no-explicit-any

import { DatabaseSync } from 'node:sqlite'
import { BudgetExceeded, configure, fetchHTML, requestsMade } from './zyte.ts'
import {
	htmlToText,
	parseItemPage,
	parseResultCount,
	parseSearchPage,
	parseShipping,
	parseStoreUsername,
	type SearchCard,
} from './parse.ts'
import { convert, loadRates } from './fx.ts'

// --- knobs ---
const DEFAULT_CONCURRENCY = 30 // parallel Zyte requests. The account allows 3000
// requests/min on every plan; the per-domain limit on ebay.com is the real
// ceiling and the pool backs off automatically when it bites.
const DEFAULT_MAX_REQUESTS = 25000 // budget stop per run; see README.
const SEGMENT_CAP = 9000 // eBay stops serving a search past ~10k results; a
// price band that yields this many gets split in half and re-walked.
const MAX_PAGES_PER_SEGMENT = 45
const LISTING_WAVE = 10 // search pages fetched concurrently while walking one
// store: ~30s/wave of 2,400 items. Still well under the ebay.com domain limit
// (~1,170 RPM observed); the real cost of a bigger wave is a slightly longer
// overshoot at each band's end.
const PAGE_REFETCHES = 1 // refetches of a page that added nothing before counting it
const END_OF_BAND_PAGES = 2 // consecutive nothing-new pages that end a band
const ROWS_PER_CSV = 50000
const DB_PATH = './data/scrape.db'

// --- CLI flags ---
// --desc | --full | --no-desc | --cap=N | --concurrency=N | --max-requests=N
// --ship-to=NZ | --convert-to=NZD | --fx=data/fx.json | --verbose
const flag = (name: string) => Deno.args.includes(`--${name}`)
const flagValue = (name: string) => {
	const arg = Deno.args.find((a) => a.startsWith(`--${name}=`))
	return arg ? Number(arg.split('=')[1]) : null
}
const flagText = (name: string) => {
	const arg = Deno.args.find((a) => a.startsWith(`--${name}=`))
	return arg ? arg.split('=')[1] : null
}
const verbose = flag('verbose') || flag('v')
const wantDesc = flag('desc')
const wantFull = flag('full')
const skipDesc = flag('no-desc') // with --full: item page only, 1 request/product
const shipTo = flagText('ship-to') // 2-letter country: geolocate item pages there
const convertTo = flagText('convert-to') // ISO currency for the CSV export
const fxPath = flagText('fx') ?? './data/fx.json'
const concurrency = flagValue('concurrency') ?? DEFAULT_CONCURRENCY
const capPerStore = flagValue('cap') ?? Number.MAX_SAFE_INTEGER
configure({ maxRequests: flagValue('max-requests') ?? DEFAULT_MAX_REQUESTS, verbose })

// CSV column order; these double as SQL column names.
const COLUMNS = [
	'store_name',
	'product_url',
	'title',
	'sku',
	'brand',
	'mpn',
	'price',
	'currency',
	'availability',
	'image_urls',
	'item_specifics',
	'description',
	'ships_to',
	'shipping_cost',
	'shipping_currency',
	'shipping_time',
]

// --- URLs ---

const itemURL = (itemId: string) => `https://www.ebay.com/itm/${itemId}`
const descPageURL = (itemId: string) => `https://itm.ebaydesc.com/itmdesc/${itemId}`

function searchPageURL(seller: string, page: number, lo?: number, hi?: number): string {
	const u = new URL('https://www.ebay.com/sch/i.html')
	u.searchParams.set('_ssn', seller)
	u.searchParams.set('_ipg', '240')
	u.searchParams.set('_pgn', String(page))
	u.searchParams.set('_sop', '15') // price ascending: stable order across pages
	if (lo !== undefined) u.searchParams.set('_udlo', lo.toFixed(2))
	if (hi !== undefined) u.searchParams.set('_udhi', hi.toFixed(2))
	return u.href
}

// --- listing walk ---

export type SearchPage = { cards: SearchCard[]; total: number | null }
type FetchPage = (url: string) => Promise<SearchPage>
const fetchSearchPage: FetchPage = async (url) => {
	const html = await fetchHTML(url)
	return { cards: parseSearchPage(html), total: parseResultCount(html) }
}

// Walk one price band of a seller's results, calling onCard for each NEW card.
// `seen` dedupes across bands. Returns how many new cards this band added and
// eBay's own result count for the band (from the first page that carried
// cards; the figure caps at 15,000+ for big sets, which is still enough to
// know the band overflows the ceiling).
//
// Pages are fetched in concurrent waves of LISTING_WAVE (page numbers are
// deterministic, so later pages can be requested before earlier ones land) and
// processed in page order. The tail of a band overshoots by a few cheap
// search requests; that is the whole cost.
//
// End-of-band detection has to survive two eBay flakes seen in the wild, both
// of which look exactly like the end of the results:
//   - a fully-formed page with zero cards and a "0 results" heading, served
//     transiently even for sellers with 150k live listings
//   - a full page containing only already-seen items, because the ordering of
//     same-price items shifts between requests and a page's window can slide
//     entirely into territory another page already covered
// So no single page is believed: a page that adds nothing new is refetched,
// and the band only ends after two consecutive page numbers confirm there is
// nothing more. (The genuine end signal is eBay repeating the last page once
// _pgn runs past the end.) The extra confirmation costs a few search requests
// per band; missing items costs the whole tail of a store.
async function walkBand(
	seller: string,
	lo: number | undefined,
	hi: number | undefined,
	cap: number,
	seen: Set<string>,
	onCard: (c: SearchCard) => void,
	fetchPage: FetchPage,
	stopWhenOverCap: boolean,
): Promise<{ added: number; total: number | null }> {
	let added = 0
	let total: number | null = null
	let zeroStreak = 0 // consecutive pages that added nothing, across waves
	const collect = (cards: SearchCard[]) => {
		let fresh = 0
		for (const card of cards) {
			if (seen.size >= cap) break
			if (seen.has(card.item_id)) continue
			seen.add(card.item_id)
			onCard(card)
			fresh++
			added++
		}
		return fresh
	}

	for (let page = 1; page <= MAX_PAGES_PER_SEGMENT && seen.size < cap;) {
		const wave: Promise<SearchPage>[] = []
		for (let i = 0; i < LISTING_WAVE && page + i <= MAX_PAGES_PER_SEGMENT; i++) {
			wave.push(fetchPage(searchPageURL(seller, page + i, lo, hi)))
		}
		const pages = await Promise.all(wave)

		let exhausted = false
		for (let i = 0; i < pages.length; i++) {
			let { cards, total: pageTotal } = pages[i]
			let newOnPage = collect(cards)
			for (let retry = 0; newOnPage === 0 && retry < PAGE_REFETCHES; retry++) {
				if (verbose) console.log(`    page ${page + i} of ${seller} added nothing, refetching`)
				;({ cards, total: pageTotal } = await fetchPage(searchPageURL(seller, page + i, lo, hi)))
				newOnPage = collect(cards)
			}
			if (total === null && cards.length > 0) total = pageTotal

			if (newOnPage === 0) {
				zeroStreak++
				if (zeroStreak >= END_OF_BAND_PAGES) {
					exhausted = true
					break
				}
			} else {
				zeroStreak = 0
			}
		}
		if (exhausted) break
		// The band overflows eBay's ~10k serving ceiling and the caller can
		// split it: stop walking, the split halves cover everything anyway.
		if (stopWhenOverCap && total !== null && total > SEGMENT_CAP) break
		page += pages.length
	}
	return { added, total }
}

// The real seller username behind a /str/ store page, for when the slug
// search finds nothing. Returns null when the page does not name one;
// a budget stop still propagates.
async function resolveSellerUsername(storeURL: string): Promise<string | null> {
	try {
		return parseStoreUsername(await fetchHTML(storeURL))
	} catch (err) {
		if (err instanceof BudgetExceeded) throw err
		return null
	}
}

// List a seller's full catalog. A band that hits eBay's ~10k search ceiling,
// by its own reported result count or by the number of cards actually served,
// is split in half (price-wise) and both halves re-walked, until every band
// fits. `fetchPage` is injectable for testing.
export async function listStoreProducts(
	seller: string,
	cap: number,
	onCard: (c: SearchCard) => void,
	fetchPage: FetchPage = fetchSearchPage,
): Promise<number> {
	const seen = new Set<string>()
	const bands: Array<[number | undefined, number | undefined]> = [[undefined, undefined]]

	while (bands.length > 0 && seen.size < cap) {
		const [lo, hi] = bands.pop()!
		const floor = lo ?? 0
		// A band narrower than one cent that still overflows is a single price
		// point holding more than eBay will serve; accepted as-is. Megastores
		// (millions of listings) really do pack 10k+ items into sub-dollar
		// windows, so splitting continues below $1.
		const splittable = hi === undefined || hi - floor > 0.01
		const { added, total } = await walkBand(seller, lo, hi, cap, seen, onCard, fetchPage, splittable)
		const overflowed = added >= SEGMENT_CAP || (total !== null && total > SEGMENT_CAP)
		if (!overflowed || !splittable) continue

		if (hi === undefined) {
			const mid = floor > 0 ? floor * 2 : 100
			bands.push([floor, mid], [mid, undefined])
		} else {
			const mid = (floor + hi) / 2
			bands.push([floor, mid], [mid, hi])
		}
	}
	return seen.size
}

// Fallback when seller search returns nothing: the /str/ slug is not always
// the seller's username, but the store page itself still lists the products.
export async function listStorePageProducts(
	storeURL: string,
	cap: number,
	onCard: (c: SearchCard) => void,
	fetchPage: FetchPage = fetchSearchPage,
): Promise<number> {
	const seen = new Set<string>()
	const pageURL = (page: number) => {
		const u = new URL(storeURL)
		u.searchParams.set('_ipg', '240')
		u.searchParams.set('_pgn', String(page))
		return u.href
	}
	// Same wave-parallel walk and flake-proof end detection as walkBand.
	const collect = (cards: SearchCard[]) => {
		let fresh = 0
		for (const card of cards) {
			if (seen.size >= cap) break
			if (seen.has(card.item_id)) continue
			seen.add(card.item_id)
			onCard(card)
			fresh++
		}
		return fresh
	}
	let zeroStreak = 0
	for (let page = 1; page <= 500 && seen.size < cap;) {
		const wave: Promise<SearchPage>[] = []
		for (let i = 0; i < LISTING_WAVE && page + i <= 500; i++) wave.push(fetchPage(pageURL(page + i)))
		const pages = await Promise.all(wave)

		let exhausted = false
		for (let i = 0; i < pages.length; i++) {
			let { cards } = pages[i]
			let newOnPage = collect(cards)
			for (let retry = 0; newOnPage === 0 && retry < PAGE_REFETCHES; retry++) {
				if (verbose) console.log(`    store page ${page + i} added nothing, refetching`)
				;({ cards } = await fetchPage(pageURL(page + i)))
				newOnPage = collect(cards)
			}
			if (newOnPage === 0) {
				zeroStreak++
				if (zeroStreak >= END_OF_BAND_PAGES) {
					exhausted = true
					break
				}
			} else {
				zeroStreak = 0
			}
		}
		if (exhausted) break
		page += pages.length
	}
	return seen.size
}

// --- database ---

function openDB(): DatabaseSync {
	const db = new DatabaseSync(DB_PATH)
	db.exec(`
		CREATE TABLE IF NOT EXISTS stores (
			store_name TEXT PRIMARY KEY,
			store_url  TEXT NOT NULL,
			status     TEXT NOT NULL DEFAULT 'pending', -- pending | discovered | empty | failed
			error      TEXT
		);
		CREATE TABLE IF NOT EXISTS products (
			item_id      TEXT PRIMARY KEY,
			product_url  TEXT NOT NULL,
			store_name   TEXT NOT NULL,
			status       TEXT NOT NULL DEFAULT 'listed', -- listed | desc_done | done | failed
			title TEXT, sku TEXT, brand TEXT, mpn TEXT,
			price TEXT, currency TEXT, availability TEXT,
			image_urls TEXT, item_specifics TEXT, description TEXT,
			ships_to TEXT, shipping_cost TEXT, shipping_currency TEXT, shipping_time TEXT,
			error TEXT,
			updated_at TEXT
		);
	`)
	// Databases created before the shipping columns existed get them added.
	for (const col of ['ships_to', 'shipping_cost', 'shipping_currency', 'shipping_time']) {
		try {
			db.exec(`ALTER TABLE products ADD COLUMN ${col} TEXT`)
		} catch {
			// Column already exists.
		}
	}
	return db
}

// Load data/stores_all.txt into the stores table (keeps existing statuses).
// The /str/ slug doubles as the seller name for search.
function seedStores(db: DatabaseSync) {
	const insert = db.prepare('INSERT OR IGNORE INTO stores (store_name, store_url) VALUES (?, ?)')
	for (const line of Deno.readTextFileSync('./data/stores_all.txt').split(/\r?\n/)) {
		const url = line.trim()
		if (!url) continue
		const slug = new URL(url).pathname.split('/').filter(Boolean).pop()
		if (slug) insert.run(slug, url)
	}
}

// --- worker pool with a live progress line ---

async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
	let index = 0
	const lane = async () => {
		while (index < items.length) await worker(items[index++])
	}
	await Promise.all(Array.from({ length: Math.max(1, limit) }, lane))
}

// Prints "done/total (rate/min, requests used)" as a phase progresses: every
// `every` completions, and at least every 2 seconds while work is finishing,
// so progress reads as live at any concurrency.
function progress(total: number, every: number) {
	const t0 = performance.now()
	let done = 0
	let lastPrintAt = t0
	return () => {
		done++
		const now = performance.now()
		if (done % every !== 0 && done !== total && now - lastPrintAt < 2000) return
		lastPrintAt = now
		const perMin = Math.round(done / ((now - t0) / 60000))
		console.log(`  ${done}/${total} (${perMin}/min, ${requestsMade()} requests)`)
	}
}

// --- phases ---

// Phase 1: listing. Walks every store not yet successfully listed.
async function listStores(db: DatabaseSync) {
	const stores = db.prepare("SELECT store_name, store_url FROM stores WHERE status != 'discovered'").all() as any[]
	if (stores.length === 0) return

	// status is set explicitly: a database created by an older version may have
	// a different column default.
	const insert = db.prepare(
		`INSERT OR IGNORE INTO products (item_id, product_url, store_name, title, price, currency, image_urls, updated_at, status)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'listed')`,
	)
	const setStatus = db.prepare('UPDATE stores SET status = ?, error = ? WHERE store_name = ?')

	console.log(`listing ${stores.length} stores (concurrency ${concurrency})`)

	// A live "found so far" line at most every 2 seconds, so a long walk of a
	// big store reads as progress rather than silence.
	let found = 0
	let lastFoundNote = performance.now()
	const noteFound = () => {
		found++
		const now = performance.now()
		if (now - lastFoundNote < 2000) return
		lastFoundNote = now
		console.log(`  found ${found} products so far (${requestsMade()} requests)`)
	}

	let budgetHit = false
	const listOne = async (store: any) => {
		if (budgetHit) return
		console.log(`checking ${store.store_name}`)
		try {
			const now = new Date().toISOString()
			const save = (c: SearchCard) => {
				insert.run(c.item_id, itemURL(c.item_id), store.store_name, c.title, c.price, c.currency, c.image_url, now)
				noteFound()
			}

			let count = await listStoreProducts(store.store_name, capPerStore, save)
			if (count === 0) {
				// The /str/ slug is not always the seller's username, and only the
				// seller search can band-split past eBay's ~10k ceiling. The store
				// page names the real username; search again with that.
				const username = await resolveSellerUsername(store.store_url)
				if (username && username.toLowerCase() !== store.store_name.toLowerCase()) {
					console.log(`  ${store.store_name} is run by seller ${username}, searching again`)
					count = await listStoreProducts(username, capPerStore, save)
				}
			}
			if (count === 0) count = await listStorePageProducts(store.store_url, capPerStore, save)

			setStatus.run(count > 0 ? 'discovered' : 'empty', null, store.store_name)
			console.log(
				`${count > 0 ? 'listed  ' : 'empty   '}${store.store_name}: ${count} products (${requestsMade()} requests)`,
			)
		} catch (err) {
			// A budget stop is a clean halt, not a failure: statuses stay as they
			// are and the next run picks up exactly here.
			if (err instanceof BudgetExceeded) {
				if (!budgetHit) {
					console.log(
						`budget stop during listing: ${requestsMade()} requests used, re-run (or raise --max-requests) to continue`,
					)
				}
				budgetHit = true
				return
			}
			setStatus.run('failed', (err as Error).message, store.store_name)
			console.error(`FAILED  ${store.store_name}: ${(err as Error).message} (will retry next run)`)
		}
	}
	await runPool(stores, concurrency, listOne)

	// One unlucky request must not cost a store its whole listing: stores that
	// failed (an upstream error that outlived the transport retries) get fresh
	// passes while the budget lasts. Already-saved products dedupe on re-walk.
	const failedStores = db.prepare("SELECT store_name, store_url FROM stores WHERE status = 'failed'")
	for (let pass = 1; pass <= 2 && !budgetHit; pass++) {
		const failed = failedStores.all() as any[]
		if (failed.length === 0) break
		console.log(`retrying ${failed.length} failed stores (pass ${pass})`)
		await runPool(failed, concurrency, listOne)
	}
}

// Phase 2 (--desc): one cheap raw request per product for the description.
async function fetchDescriptions(db: DatabaseSync) {
	const rows = db.prepare("SELECT item_id FROM products WHERE status IN ('listed', 'pending')").all() as any[]
	const save = db.prepare("UPDATE products SET status = 'desc_done', description = ?, updated_at = ? WHERE item_id = ?")

	console.log(`fetching ${rows.length} descriptions (concurrency ${concurrency})`)
	const tick = progress(rows.length, 50)
	let budgetHit = false
	await runPool(rows, concurrency, async (row) => {
		if (budgetHit) return
		try {
			const text = htmlToText(await fetchHTML(descPageURL(row.item_id)))
			save.run(text, new Date().toISOString(), row.item_id)
		} catch (err) {
			if (err instanceof BudgetExceeded) {
				if (!budgetHit) {
					console.log(`budget stop during descriptions: ${requestsMade()} requests used, re-run to continue`)
				}
				budgetHit = true
				return // rows stay 'listed'; the next run picks them up
			}
			if (verbose) console.log(`  desc FAIL ${row.item_id}: ${(err as Error).message}`)
		}
		tick()
	})
}

// Phase 3 (--full): item page (+ description unless --no-desc) per product.
// With --ship-to the item page is fetched as a viewer from that country, so
// eBay renders its shipping cost and delivery estimate for free on the same
// request.
async function fetchDetails(db: DatabaseSync) {
	const rows = db.prepare("SELECT item_id FROM products WHERE status IN ('listed', 'pending', 'desc_done', 'failed')")
		.all() as any[]
	const save = db.prepare(
		`UPDATE products SET status = 'done',
			title = COALESCE(NULLIF(?, ''), title), sku = ?, brand = ?, mpn = ?, price = ?, currency = ?,
			availability = ?, image_urls = ?, item_specifics = ?, description = COALESCE(?, description),
			ships_to = ?, shipping_cost = ?, shipping_currency = ?, shipping_time = ?, updated_at = ?
		 WHERE item_id = ?`,
	)
	const fail = db.prepare("UPDATE products SET status = 'failed', error = ?, updated_at = ? WHERE item_id = ?")

	const itemFetchOpts = shipTo ? { geolocation: shipTo } : {}
	console.log(`fetching full details for ${rows.length} products (concurrency ${concurrency})`)
	const tick = progress(rows.length, 25) // ~every 1.3s at full speed, keeps the web UI lively
	let budgetHit = false
	await runPool(rows, concurrency, async (row) => {
		if (budgetHit) return
		const now = new Date().toISOString()
		try {
			const [pageHTML, descHTML] = await Promise.all([
				fetchHTML(itemURL(row.item_id), itemFetchOpts),
				skipDesc ? Promise.resolve(null) : fetchHTML(descPageURL(row.item_id)),
			])
			const d = parseItemPage(pageHTML)
			const ship = shipTo ? parseShipping(pageHTML) : null
			save.run(
				d.title,
				row.item_id,
				d.brand,
				d.mpn,
				d.price,
				d.currency,
				d.availability,
				d.image_urls,
				d.item_specifics,
				descHTML === null ? null : htmlToText(descHTML),
				ship?.ships_to ?? '',
				ship?.shipping_cost ?? '',
				ship?.shipping_currency ?? '',
				ship?.shipping_time ?? '',
				now,
				row.item_id,
			)
		} catch (err) {
			if (err instanceof BudgetExceeded) {
				if (!budgetHit) {
					console.log(`budget stop during full details: ${requestsMade()} requests used, re-run to continue`)
				}
				budgetHit = true
				return
			}
			fail.run((err as Error).message, now, row.item_id)
		}
		tick()
	})
}

// --- CSV export (the deliverable) ---

function csvField(value: unknown): string {
	const s = value == null ? '' : String(value)
	return /[",\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s
}

// Writes rows live and rolls to a new file every ROWS_PER_CSV rows.
export class SplitCSVWriter {
	private fileIndex = 0
	private rowsInFile = 0
	private file: Deno.FsFile | null = null
	private encoder = new TextEncoder()

	constructor(private baseName: string, private header: string[], private rowsPerFile: number) {}

	private openNextFile() {
		this.file?.close()
		this.fileIndex++
		this.rowsInFile = 0
		const path = `./data/${this.baseName}_${this.fileIndex}.csv`
		this.file = Deno.openSync(path, { create: true, write: true, truncate: true })
		this.writeLine(this.header.map(csvField).join(','))
		console.log(`Writing to ${path}`)
	}

	private writeLine(line: string) {
		this.file!.writeSync(this.encoder.encode(line + '\n'))
	}

	write(row: Record<string, unknown>) {
		if (!this.file || this.rowsInFile >= this.rowsPerFile) this.openNextFile()
		this.writeLine(this.header.map((col) => csvField(row[col])).join(','))
		this.rowsInFile++
	}

	close() {
		this.file?.close()
	}
}

// Convert a row's prices into the target currency, in place. Rows in a
// currency with no known rate keep their original values.
function convertRow(row: any, to: string, fx: NonNullable<ReturnType<typeof loadRates>>) {
	const price = convert(Number(row.price), row.currency || 'USD', to, fx)
	if (row.price !== '' && row.price != null && price !== null) {
		row.price = price.toFixed(2)
		row.currency = to
	}
	const shipping = convert(Number(row.shipping_cost), row.shipping_currency || 'USD', to, fx)
	if (row.shipping_cost !== '' && row.shipping_cost != null && shipping !== null) {
		row.shipping_cost = shipping.toFixed(2)
		row.shipping_currency = to
	}
}

export function exportCSV() {
	const db = openDB()
	const rows = db.prepare(
		`SELECT ${COLUMNS.join(', ')} FROM products WHERE status IN ('listed', 'pending', 'desc_done', 'done')`,
	).all() as any[]

	const fx = convertTo ? loadRates(fxPath) : null
	if (convertTo && !fx) {
		console.log(`warning: no exchange rates at ${fxPath}; exporting prices unconverted`)
	}

	const writer = new SplitCSVWriter('products', COLUMNS, ROWS_PER_CSV)
	for (const row of rows) {
		if (convertTo && fx) convertRow(row, convertTo, fx)
		writer.write(row)
	}
	writer.close()
	db.close()
	console.log(`Exported ${rows.length} products to data/products_*.csv`)
}

// --- run ---

if (import.meta.main) {
	const db = openDB()
	seedStores(db)
	await listStores(db)
	if (wantDesc) await fetchDescriptions(db)
	if (wantFull) await fetchDetails(db)

	const stores = db.prepare('SELECT status, COUNT(*) AS n FROM stores GROUP BY status').all() as any[]
	const products = db.prepare('SELECT status, COUNT(*) AS n FROM products GROUP BY status').all() as any[]
	const problems = db.prepare(
		"SELECT store_name, status FROM stores WHERE status IN ('failed', 'empty') ORDER BY status",
	).all() as any[]
	db.close()

	console.log(`\nZyte requests this run: ${requestsMade()}`)
	console.log('Stores:  ', stores.map((s) => `${s.status}=${s.n}`).join(' '))
	console.log('Products:', products.map((p) => `${p.status}=${p.n}`).join(' '))
	if (problems.length) {
		console.log('Needs attention:')
		for (const s of problems) console.log(`  ${s.status}: ${s.store_name}`)
	}
	exportCSV()
}
