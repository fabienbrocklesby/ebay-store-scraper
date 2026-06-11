// Unit tests for the pure HTML parsers, against compact synthetic fixtures
// that mirror eBay's real markup anchors.
import { assertEquals } from '@std/assert'
import { htmlToText, parseItemPage, parseSearchPage } from './parse.ts'

function card(id: string, title: string, price = '18.20', img = 'zKQAAOSwFnFWFVhC') {
	return `<li class="s-card s-card--horizontal" data-listingid=${id}>
		<a href=https://www.ebay.com/itm/${id}?meta=x><img src=https://i.ebayimg.com/images/g/${img}/s-l500.webp></a>
		<div class="s-card__title"><span class=su-styled-text>${title}</span></div>
		<span class=su-styled-text>$${price}</span></li>`
}

Deno.test('parseSearchPage extracts cards and dedupes', () => {
	const html = '<ul>' + card('111', 'Widget One') + card('222', 'Widget Two', '1,234.56') +
		card('111', 'Widget One Again') + '</ul>'
	const cards = parseSearchPage(html)
	assertEquals(cards.length, 2)
	assertEquals(cards[0], {
		item_id: '111',
		title: 'Widget One',
		price: '18.20',
		currency: 'USD',
		image_url: 'https://i.ebayimg.com/images/g/zKQAAOSwFnFWFVhC/s-l1600.jpg',
	})
	assertEquals(cards[1].price, '1234.56')
})

Deno.test('parseSearchPage drops the "Shop on eBay" placeholder card', () => {
	const html = card('123456', 'Shop on eBay') + card('333', 'Real Item')
	const cards = parseSearchPage(html)
	assertEquals(cards.map((c) => c.item_id), ['333'])
})

Deno.test('parseSearchPage returns empty for a page with no cards', () => {
	assertEquals(parseSearchPage('<html><body>0 results</body></html>'), [])
})

Deno.test('parseSearchPage handles the store-page (str-item-card) layout', () => {
	const html = `<section><article data-testid=ig-375211488286 class="str-item-card">
		<a href=https://www.ebay.com/itm/375211488286?meta=x aria-label="Chrome Tailgate Molding">
		<img src=https://i.ebayimg.com/images/g/HLcAAOSwx9FlsUJ5/s-l500.webp></a>
		<span>$129.99</span></article></section>`
	assertEquals(parseSearchPage(html), [{
		item_id: '375211488286',
		title: 'Chrome Tailgate Molding',
		price: '129.99',
		currency: 'USD',
		image_url: 'https://i.ebayimg.com/images/g/HLcAAOSwx9FlsUJ5/s-l1600.jpg',
	}])
})

const ITEM_PAGE = `<html><head><title>Control Arm Kit for BMW | eBay</title></head><body>
<script>x = {"price":{"value":228.59,"currency":"USD"}}</script>
<div>6 available</div>
<div class="ux-image-carousel">
	<img src=https://i.ebayimg.com/images/g/AAA111/s-l500.webp>
	<img src=https://i.ebayimg.com/images/g/BBB222/s-l64.webp>
	<img src=https://i.ebayimg.com/images/g/AAA111/s-l1600.webp>
</div>
<h2>Item specifics</h2>
<dl class="ux-labels-values"><dt class="ux-labels-values__labels"><span>Brand</span></dt>
	<dd class="ux-labels-values__values"><span>maXpeedingrods</span></dd></dl>
<dl class="ux-labels-values"><dt class="ux-labels-values__labels"><span>Manufacturer Part Number</span></dt>
	<dd class="ux-labels-values__values"><span>OYUG78</span></dd></dl>
<h2>Item description</h2>
<img src=https://i.ebayimg.com/images/g/RECOMMENDED99/s-l500.webp>
</body></html>`

Deno.test('parseItemPage extracts title, price, stock, specifics, brand, mpn', () => {
	const d = parseItemPage(ITEM_PAGE)
	assertEquals(d.title, 'Control Arm Kit for BMW')
	assertEquals(d.price, '228.59')
	assertEquals(d.currency, 'USD')
	assertEquals(d.availability, '6')
	assertEquals(d.brand, 'maXpeedingrods')
	assertEquals(d.mpn, 'OYUG78')
	assertEquals(d.item_specifics, 'Brand: maXpeedingrods | Manufacturer Part Number: OYUG78')
})

Deno.test('parseItemPage keeps gallery images, drops recommendation images', () => {
	const d = parseItemPage(ITEM_PAGE)
	assertEquals(
		d.image_urls,
		[
			'https://i.ebayimg.com/images/g/AAA111/s-l1600.jpg',
			'https://i.ebayimg.com/images/g/BBB222/s-l1600.jpg',
		].join(' | '),
	)
})

Deno.test('parseItemPage falls back to the h1 when the <title> tag is empty', () => {
	// Some page variants ship an empty <title>; the h1 inside x-item-title still has it.
	const html = ITEM_PAGE.replace(
		'<title>Control Arm Kit for BMW | eBay</title>',
		'<title></title>',
	).replace(
		'<body>',
		'<body><div class="x-item-title"><h1 class=x-item-title__mainTitle><span class="ux-textspans ux-textspans--BOLD">Control Arm Kit for BMW</span></h1></div>',
	)
	assertEquals(parseItemPage(html).title, 'Control Arm Kit for BMW')
})

Deno.test('htmlToText strips tags, scripts, and entities', () => {
	const text = htmlToText('<div><script>junk()</script><p>A &amp; B&nbsp;&quot;C&quot;</p>  <b>D</b></div>')
	assertEquals(text, 'A & B "C" D')
})
