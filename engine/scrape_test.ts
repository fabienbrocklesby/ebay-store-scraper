// Tests for the listing walker: pagination must stop on an exhausted page,
// items must dedupe across pages and price bands, the per-store cap must hold,
// and a band that hits eBay's ~10k search ceiling must split and re-walk.
import { assertEquals } from '@std/assert'
import { listStoreProducts } from './scrape.ts'
import type { SearchCard } from './parse.ts'

function card(id: number): SearchCard {
	return { item_id: String(id), title: `item ${id}`, price: '1.00', currency: 'USD', image_url: '' }
}

function params(url: string) {
	const u = new URL(url)
	return { page: Number(u.searchParams.get('_pgn')), lo: u.searchParams.get('_udlo'), hi: u.searchParams.get('_udhi') }
}

Deno.test('paginates until a page adds nothing new', async () => {
	// Page 1: items 1-240, page 2: items 241-300, page 3 repeats page 2 (eBay
	// serves the last page again when _pgn runs past the end).
	const fetchPage = (url: string) => {
		const { page } = params(url)
		if (page === 1) return Promise.resolve(Array.from({ length: 240 }, (_, i) => card(i + 1)))
		return Promise.resolve(Array.from({ length: 60 }, (_, i) => card(241 + i)))
	}
	const out: SearchCard[] = []
	const count = await listStoreProducts('x', Number.MAX_SAFE_INTEGER, (c) => out.push(c), fetchPage)
	assertEquals(count, 300)
	assertEquals(new Set(out.map((c) => c.item_id)).size, 300)
})

Deno.test('empty store yields zero', async () => {
	const count = await listStoreProducts('x', Number.MAX_SAFE_INTEGER, () => {}, () => Promise.resolve([]))
	assertEquals(count, 0)
})

Deno.test('cap stops the walk', async () => {
	const fetchPage = (url: string) => {
		const { page } = params(url)
		return Promise.resolve(Array.from({ length: 240 }, (_, i) => card((page - 1) * 240 + i + 1)))
	}
	const out: SearchCard[] = []
	const count = await listStoreProducts('x', 250, (c) => out.push(c), fetchPage)
	assertEquals(count, 250)
	assertEquals(out.length, 250)
})

Deno.test('a band that hits the search ceiling splits into price bands', async () => {
	// Unbanded walk serves 9,600 items (40 full pages) then stops serving new
	// ones: looks truncated. Banded walks serve distinct extra items, proving
	// the splitter re-walked with _udlo/_udhi.
	const fetchPage = (url: string) => {
		const { page, lo, hi } = params(url)
		if (lo === null && hi === null) {
			if (page <= 40) return Promise.resolve(Array.from({ length: 240 }, (_, i) => card((page - 1) * 240 + i + 1)))
			return Promise.resolve(Array.from({ length: 240 }, (_, i) => card(39 * 240 + i + 1))) // repeat last page
		}
		const key = (Number(lo ?? 0) * 7919 + Number(hi ?? 999983)) % 100000
		if (page === 1) return Promise.resolve(Array.from({ length: 50 }, (_, i) => card(1000000 + key * 100 + i)))
		return Promise.resolve([])
	}
	const out: SearchCard[] = []
	const count = await listStoreProducts('x', Number.MAX_SAFE_INTEGER, (c) => out.push(c), fetchPage)
	assertEquals(count > 9600, true)
	assertEquals(new Set(out.map((c) => c.item_id)).size, count)
})

Deno.test('a fetch error propagates (never silently treated as empty)', async () => {
	let threw = ''
	try {
		await listStoreProducts('x', 10, () => {}, () => Promise.reject(new Error('Zyte returned 520')))
	} catch (err) {
		threw = (err as Error).message
	}
	assertEquals(threw, 'Zyte returned 520')
})
