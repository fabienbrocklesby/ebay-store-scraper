import { assertEquals } from '@std/assert'
import { parseStoresFile } from './validate.ts'

Deno.test('accepts plain store URLs', () => {
	const r = parseStoresFile('https://www.ebay.com/str/alphaparts\nhttps://www.ebay.com/str/bravotrading')
	assertEquals(r.errors, [])
	assertEquals(r.stores, [
		'https://www.ebay.com/str/alphaparts',
		'https://www.ebay.com/str/bravotrading',
	])
})

Deno.test('normalizes trailing slashes, query strings, http, missing www and scheme', () => {
	const r = parseStoresFile(
		[
			'https://www.ebay.com/str/alpha/',
			'http://ebay.com/str/bravo?_tab=about',
			'www.ebay.com/str/charlie',
			'ebay.com/str/delta/',
			'HTTPS://WWW.EBAY.COM/str/echo',
		].join('\n'),
	)
	assertEquals(r.errors, [])
	assertEquals(r.stores, [
		'https://www.ebay.com/str/alpha',
		'https://www.ebay.com/str/bravo',
		'https://www.ebay.com/str/charlie',
		'https://www.ebay.com/str/delta',
		'https://www.ebay.com/str/echo',
	])
})

Deno.test('accepts bare slugs', () => {
	const r = parseStoresFile('alphaparts\nmy-store_2.shop')
	assertEquals(r.errors, [])
	assertEquals(r.stores, [
		'https://www.ebay.com/str/alphaparts',
		'https://www.ebay.com/str/my-store_2.shop',
	])
})

Deno.test('collapses store category pages to the store itself', () => {
	const r = parseStoresFile('https://www.ebay.com/str/alpha/Car-Parts/_i.html?_storecat=5')
	assertEquals(r.errors, [])
	assertEquals(r.stores, ['https://www.ebay.com/str/alpha'])
})

Deno.test('skips blank lines and keeps real line numbers in errors', () => {
	const r = parseStoresFile('\nhttps://www.ebay.com/str/alpha\n\n\nnot a link!\n')
	assertEquals(r.stores, ['https://www.ebay.com/str/alpha'])
	assertEquals(r.errors.length, 1)
	assertEquals(r.errors[0].line, 5)
	assertEquals(r.errors[0].text, 'not a link!')
	assertEquals(
		r.errors[0].message,
		'Line 5 is not an eBay store link. Expected something like https://www.ebay.com/str/storename',
	)
})

Deno.test('rejects non-store eBay links with the line number', () => {
	const r = parseStoresFile('https://www.ebay.com/itm/123456789')
	assertEquals(r.stores, [])
	assertEquals(r.errors[0].line, 1)
	assertEquals(
		r.errors[0].message,
		'Line 1 is an eBay link but not a store link. Expected something like https://www.ebay.com/str/storename',
	)
})

Deno.test('rejects other eBay country sites with a clear message', () => {
	const r = parseStoresFile('https://www.ebay.co.uk/str/alpha')
	assertEquals(r.stores, [])
	assertEquals(r.errors[0].message.includes('only www.ebay.com store links are supported'), true)
})

Deno.test('rejects non-eBay URLs', () => {
	const r = parseStoresFile('https://www.amazon.com/shops/whatever')
	assertEquals(r.errors[0].message.includes('is not an eBay link'), true)
})

Deno.test('rejects /str/ with no store name', () => {
	const r = parseStoresFile('https://www.ebay.com/str/')
	assertEquals(r.stores, [])
	assertEquals(r.errors.length, 1)
})

Deno.test('deduplicates repeated stores case-insensitively and counts them', () => {
	const r = parseStoresFile('https://www.ebay.com/str/Alpha\nalpha\nhttps://www.ebay.com/str/ALPHA/')
	assertEquals(r.stores, ['https://www.ebay.com/str/Alpha'])
	assertEquals(r.duplicates, 2)
	assertEquals(r.errors, [])
})

Deno.test('handles windows line endings', () => {
	const r = parseStoresFile('https://www.ebay.com/str/alpha\r\nhttps://www.ebay.com/str/bravo\r\n')
	assertEquals(r.errors, [])
	assertEquals(r.stores.length, 2)
})
