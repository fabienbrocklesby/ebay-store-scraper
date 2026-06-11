// Unit tests for the pure HTML parsers, against compact synthetic fixtures
// that mirror eBay's real markup anchors.
import { assertEquals } from '@std/assert'
import { htmlToText, parseItemPage, parseResultCount, parseSearchPage, parseShipping } from './parse.ts'

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

Deno.test('parseResultCount reads exact and capped ("15,000+") counts', () => {
	// Real markup: the count sits in the srp-controls heading, often wrapped in
	// framework comment nodes.
	const heading = (text: string) =>
		`<div class="srp-controls__control srp-controls__count">
			<h1 class=srp-controls__count-heading><!--F#f_0-->${text}<!--F/--></h1></div>`
	assertEquals(parseResultCount(heading('153 results')), 153)
	assertEquals(parseResultCount(heading('1 result')), 1)
	assertEquals(parseResultCount(heading('15,000+ results')), 15000)
	assertEquals(parseResultCount(heading('0 results')), 0)
	assertEquals(parseResultCount('<html><body>no heading</body></html>'), null)
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

// --- shipping ---

const SHIPPING_BLOCK = `
<div class="ux-labels-values columns ux-labels-values--shipping">
	<dt><span class="ux-textspans">Shipping:</span></dt>
	<dd><span class="ux-textspans ux-textspans--BOLD">US $18.16</span>
	<span class="ux-textspans ux-textspans--SECONDARY">(approx NZD31.33)</span>&nbsp;
	<span class="ux-textspans">eBay International Shipping</span></dd>
</div>
<div class="ux-labels-values ux-labels-values--deliverto">
	<dt><span class="ux-textspans">Delivery:</span></dt>
	<dd><span class="ux-textspans">Estimated between</span> <span class="ux-textspans--BOLD">Mon, Jun 29</span>
	<span> and </span><span class="ux-textspans--BOLD">Wed, Jul 8</span><span> to </span><span>1023</span></dd>
</div>`

Deno.test('parseShipping reads cost, currency, and the delivery window', () => {
	assertEquals(parseShipping(SHIPPING_BLOCK), {
		ships_to: 'yes',
		shipping_cost: '18.16',
		shipping_currency: 'USD',
		shipping_time: 'Mon, Jun 29 to Wed, Jul 8',
	})
})

Deno.test('parseShipping handles free shipping', () => {
	const html = `<div class="ux-labels-values--shipping"><dt>Shipping:</dt>
		<dd><span class="ux-textspans">Free shipping</span></dd></div>`
	const s = parseShipping(html)
	assertEquals(s.ships_to, 'yes')
	assertEquals(s.shipping_cost, '0.00')
	assertEquals(s.shipping_currency, '')
})

Deno.test('parseShipping flags items that do not ship to the country', () => {
	const html = `<div class="ux-labels-values--shipping"><dt>Shipping:</dt>
		<dd><span class="ux-textspans">May not ship to New Zealand - Read item description</span></dd></div>`
	assertEquals(parseShipping(html), {
		ships_to: 'no',
		shipping_cost: '',
		shipping_currency: '',
		shipping_time: '',
	})
})

Deno.test('parseShipping reads other currencies and thousands separators', () => {
	const html = `<div class="ux-labels-values--shipping"><dd><span>NZ $1,234.50</span></dd></div>`
	const s = parseShipping(html)
	assertEquals(s.shipping_cost, '1234.50')
	assertEquals(s.shipping_currency, 'NZD')
})

Deno.test('parseShipping returns empty fields when the page has no shipping block', () => {
	assertEquals(parseShipping('<html><body>nothing here</body></html>').ships_to, '')
})
