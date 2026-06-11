// Tests for the listing walker: pagination must stop once eBay starts
// repeating the last page, items must dedupe across pages and price bands,
// the per-store cap must hold, a band that hits eBay's ~10k search ceiling
// must split and re-walk, and neither of eBay's transient flakes (a blank
// "0 results" page, or a full page of only already-seen items) may be read
// as the end of the store.
import { assertEquals } from '@std/assert'
import { listStoreProducts, type SearchPage } from './scrape.ts'
import type { SearchCard } from './parse.ts'

function card(id: number): SearchCard {
	return { item_id: String(id), title: `item ${id}`, price: '1.00', currency: 'USD', image_url: '' }
}

function page(cards: SearchCard[], total: number | null = null): Promise<SearchPage> {
	return Promise.resolve({ cards, total })
}

function params(url: string) {
	const u = new URL(url)
	return { page: Number(u.searchParams.get('_pgn')), lo: u.searchParams.get('_udlo'), hi: u.searchParams.get('_udhi') }
}

Deno.test('paginates until a page adds nothing new', async () => {
	// Page 1: items 1-240, page 2: items 241-300, page 3 repeats page 2 (eBay
	// serves the last page again when _pgn runs past the end).
	const fetchPage = (url: string) => {
		const { page: p } = params(url)
		if (p === 1) return page(Array.from({ length: 240 }, (_, i) => card(i + 1)))
		return page(Array.from({ length: 60 }, (_, i) => card(241 + i)))
	}
	const out: SearchCard[] = []
	const count = await listStoreProducts('x', Number.MAX_SAFE_INTEGER, (c) => out.push(c), fetchPage)
	assertEquals(count, 300)
	assertEquals(new Set(out.map((c) => c.item_id)).size, 300)
})

Deno.test('empty store yields zero', async () => {
	const count = await listStoreProducts('x', Number.MAX_SAFE_INTEGER, () => {}, () => page([]))
	assertEquals(count, 0)
})

Deno.test('a transient blank page is refetched, not read as the end', async () => {
	// 3 full pages then a genuine end, but the FIRST serve of page 2 is eBay's
	// blank flake. Without the retry the walk would stop at 240 items.
	const blanked = new Set<string>()
	const fetchPage = (url: string) => {
		const { page: p } = params(url)
		if (p === 2 && !blanked.has(url)) {
			blanked.add(url)
			return page([], 0) // the flake even claims "0 results"
		}
		if (p <= 3) return page(Array.from({ length: 240 }, (_, i) => card((p - 1) * 240 + i + 1)))
		return page(Array.from({ length: 240 }, (_, i) => card(2 * 240 + i + 1))) // repeat last page
	}
	const out: SearchCard[] = []
	const count = await listStoreProducts('x', Number.MAX_SAFE_INTEGER, (c) => out.push(c), fetchPage)
	assertEquals(count, 720)
	assertEquals(new Set(out.map((c) => c.item_id)).size, 720)
})

Deno.test('a stale page of already-seen items does not end the walk', async () => {
	// eBay's ordering of same-price items shifts between requests: page 3 can
	// arrive containing only items pages 1-2 already covered. The walk must
	// push past one such page and keep collecting; only two consecutive
	// nothing-new pages mean the band is really done.
	const fetchPage = (url: string) => {
		const { page: p } = params(url)
		if (p === 3) return page(Array.from({ length: 240 }, (_, i) => card(240 + i + 1))) // page 2 again
		if (p <= 5) return page(Array.from({ length: 240 }, (_, i) => card((p - 1) * 240 + i + 1)))
		return page(Array.from({ length: 240 }, (_, i) => card(4 * 240 + i + 1))) // repeat last page
	}
	const out: SearchCard[] = []
	const count = await listStoreProducts('x', Number.MAX_SAFE_INTEGER, (c) => out.push(c), fetchPage)
	assertEquals(count, 4 * 240) // pages 1, 2, 4, 5; page 3 contributed nothing
	assertEquals(new Set(out.map((c) => c.item_id)).size, count)
})

Deno.test('cap stops the walk', async () => {
	const fetchPage = (url: string) => {
		const { page: p } = params(url)
		return page(Array.from({ length: 240 }, (_, i) => card((p - 1) * 240 + i + 1)))
	}
	const out: SearchCard[] = []
	const count = await listStoreProducts('x', 250, (c) => out.push(c), fetchPage)
	assertEquals(count, 250)
	assertEquals(out.length, 250)
})

Deno.test('a band that hits the search ceiling splits into price bands', async () => {
	// Unbanded walk serves 9,600 items (40 full pages) then stops serving new
	// ones: looks truncated. Banded walks serve distinct extra items, proving
	// the splitter re-walked with _udlo/_udhi. No reported totals here: the
	// split must trigger from the served count alone.
	const fetchPage = (url: string) => {
		const { page: p, lo, hi } = params(url)
		if (lo === null && hi === null) {
			if (p <= 40) return page(Array.from({ length: 240 }, (_, i) => card((p - 1) * 240 + i + 1)))
			return page(Array.from({ length: 240 }, (_, i) => card(39 * 240 + i + 1))) // repeat last page
		}
		const key = (Number(lo ?? 0) * 7919 + Number(hi ?? 999983)) % 100000
		if (p === 1) return page(Array.from({ length: 50 }, (_, i) => card(1000000 + key * 100 + i)))
		return page([])
	}
	const out: SearchCard[] = []
	const count = await listStoreProducts('x', Number.MAX_SAFE_INTEGER, (c) => out.push(c), fetchPage)
	assertEquals(count > 9600, true)
	assertEquals(new Set(out.map((c) => c.item_id)).size, count)
})

Deno.test('a band reporting more than the ceiling splits early instead of walking 45 pages', async () => {
	// eBay reports "15,000+ results" for the unbanded search: the walk must
	// split after its first wave rather than burn 45 pages on a result set the
	// ceiling will truncate anyway.
	let maxUnbandedPage = 0
	const fetchPage = (url: string) => {
		const { page: p, lo, hi } = params(url)
		if (lo === null && hi === null) {
			maxUnbandedPage = Math.max(maxUnbandedPage, p)
			return page(Array.from({ length: 240 }, (_, i) => card((p - 1) * 240 + i + 1)), 15000)
		}
		const key = (Number(lo ?? 0) * 7919 + Number(hi ?? 999983)) % 100000
		if (p === 1) return page(Array.from({ length: 50 }, (_, i) => card(1000000 + key * 100 + i)), 50)
		return page([], 50)
	}
	const out: SearchCard[] = []
	const count = await listStoreProducts('x', Number.MAX_SAFE_INTEGER, (c) => out.push(c), fetchPage)
	assertEquals(maxUnbandedPage, 5) // one wave, not MAX_PAGES_PER_SEGMENT
	assertEquals(count, 5 * 240 + 2 * 50) // first wave plus both band halves
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
