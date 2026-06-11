// Pure HTML parsers for the three eBay page types we fetch. No network, no
// state: raw HTML in, plain data out. Everything here is unit-tested against
// fixtures in parse_test.ts.
//
// eBay's markup anchors (stable as of June 2026):
//   search results  - <li class="s-card" data-listingid=...> cards
//   item page       - "Item specifics" <dl class="ux-labels-values"> rows,
//                     gallery inside "ux-image-carousel"
//   description     - separate page at itm.ebaydesc.com (plain HTML)

// A product as it appears on a search results page.
export type SearchCard = {
	item_id: string
	title: string
	price: string
	currency: string
	image_url: string
}

// The extra fields only the item page has.
export type ItemDetails = {
	title: string
	price: string
	currency: string
	availability: string
	image_urls: string
	item_specifics: string
	brand: string
	mpn: string
}

const CURRENCY_SYMBOLS: Record<string, string> = { '$': 'USD', '£': 'GBP', '€': 'EUR' }

// Strip HTML down to readable text.
export function htmlToText(html: string): string {
	return html
		.replace(/<(script|style)[\s\S]*?<\/(script|style)>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;/g, "'")
		.replace(/\s+/g, ' ')
		.trim()
}

// eBay injects a "Shop on eBay" placeholder card (item id 123456) into sparse
// or invalid results; it is not a real listing.
function isPlaceholder(card: SearchCard): boolean {
	return card.item_id === '123456' || card.title === 'Shop on eBay'
}

// Build a card from one block of card HTML, given its item id and title.
function toCard(block: string, item_id: string, title: string): SearchCard {
	const priceMatch = block.match(/([$£€])\s?([\d,]+\.\d\d)/)
	const imageGroup = block.match(/i\.ebayimg\.com\/images\/g\/([A-Za-z0-9~_-]+)\//)?.[1]
	return {
		item_id,
		title: htmlToText(title),
		price: priceMatch?.[2]?.replaceAll(',', '') ?? '',
		currency: priceMatch ? CURRENCY_SYMBOLS[priceMatch[1]] ?? priceMatch[1] : '',
		image_url: imageGroup ? `https://i.ebayimg.com/images/g/${imageGroup}/s-l1600.jpg` : '',
	}
}

// Parse every product card from a raw listing page. Handles both layouts eBay
// serves: search results ("s-card" list items) and store pages
// ("str-item-card" articles).
export function parseSearchPage(html: string): SearchCard[] {
	const cards: SearchCard[] = []
	const seen = new Set<string>()
	const add = (card: SearchCard) => {
		if (isPlaceholder(card) || seen.has(card.item_id)) return
		seen.add(card.item_id)
		cards.push(card)
	}

	// Search results layout.
	for (const block of html.split('<li class="s-card').slice(1)) {
		const item_id = block.match(/data-listingid=["']?(\d+)/)?.[1]
		if (!item_id) continue
		const title = block.match(/s-card__title[^>]*>([\s\S]{0,300}?)<\/(?:span|div)/)?.[1] ?? ''
		add(toCard(block, item_id, title))
	}

	// Store page layout.
	for (const block of html.split('<article data-testid=ig-').slice(1)) {
		const item_id = block.match(/^(\d+)/)?.[1]
		if (!item_id) continue
		const title = block.match(/\/itm\/\d+[^>]*aria-label="([^"]+)"/)?.[1] ?? ''
		add(toCard(block, item_id, title))
	}

	return cards
}

// eBay's own result count from a search page ("153 results", "15,000+
// results"; the figure caps at 15,000+ for big result sets). Returns null when
// the page carries no count. CAUTION: eBay transiently serves a fully-formed
// page claiming "0 results" for sellers with thousands of live listings, so a
// count is only trustworthy on a page that also carries product cards.
export function parseResultCount(html: string): number | null {
	const m = html.match(/srp-controls__count-heading[^>]*>[\s\S]{0,80}?([\d,]+)\+?\s*results?/)
	return m ? Number(m[1].replaceAll(',', '')) : null
}

// Shipping and delivery as eBay renders them for the viewer's country (the
// page fetch is geolocated there). Empty fields mean eBay did not state them.
//
// Markup anchors: the shipping row is a "ux-labels-values--shipping" block
// ("US $18.16 (approx NZD31.33) eBay International Shipping" or "Free
// shipping" or "May not ship to New Zealand"); the delivery row is a
// "ux-labels-values--deliverto" block ("Estimated between Mon, Jun 29 and
// Wed, Jul 8 to 1023").
export type ShippingInfo = {
	ships_to: 'yes' | 'no' | ''
	shipping_cost: string // amount only, '0.00' for free shipping
	shipping_currency: string
	shipping_time: string // e.g. 'Mon, Jun 29 to Wed, Jul 8'
}

const SHIP_MONEY = /(US\s?\$|NZ\s?\$|AU\s?\$|C\s?\$|£|€|GBP\s?|EUR\s?|\$)\s?([\d,]+(?:\.\d+)?)/
const SHIP_CURRENCIES: [RegExp, string][] = [
	[/^US/, 'USD'],
	[/^NZ/, 'NZD'],
	[/^AU/, 'AUD'],
	[/^C/, 'CAD'],
	[/^£/, 'GBP'],
	[/^(€|EUR)/, 'EUR'],
	[/^GBP/, 'GBP'],
	[/^\$/, 'USD'],
]

function labeledRowText(html: string, marker: string): string {
	const at = html.indexOf(marker)
	return at < 0 ? '' : htmlToText(html.slice(at, at + 4000))
}

export function parseShipping(html: string): ShippingInfo {
	const none: ShippingInfo = { ships_to: '', shipping_cost: '', shipping_currency: '', shipping_time: '' }
	const shipping = labeledRowText(html, 'ux-labels-values--shipping')
	const delivery = labeledRowText(html, 'ux-labels-values--deliverto')
	if (!shipping && !delivery) return none

	if (/(does not|may not|doesn'?t) ship to/i.test(`${shipping} ${delivery}`)) {
		return { ...none, ships_to: 'no' }
	}

	let cost = ''
	let currency = ''
	const money = shipping.match(SHIP_MONEY)
	if (money) {
		cost = money[2].replaceAll(',', '')
		currency = SHIP_CURRENCIES.find(([re]) => re.test(money[1]))?.[1] ?? ''
	} else if (/\bfree\b/i.test(shipping)) {
		cost = '0.00'
	}

	const between = delivery.match(
		/Estimated between\s+([A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2})\s+and\s+([A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2})/,
	)
	const onOrBefore = delivery.match(/Estimated (?:delivery )?on or before\s+([A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2})/)
	const time = between ? `${between[1]} to ${between[2]}` : onOrBefore ? `by ${onOrBefore[1]}` : ''

	return { ships_to: 'yes', shipping_cost: cost, shipping_currency: currency, shipping_time: time }
}

// Parse one "Item specifics" row (a <dl> block) into [label, value].
function parseSpecificsRow(block: string): [string, string] | null {
	const label = block.match(/ux-labels-values__labels[\s\S]{0,300}?<span[^>]*>([^<]+)<\/span>/)?.[1]
	const valuesAt = block.indexOf('ux-labels-values__values')
	if (!label || valuesAt < 0) return null
	const spans = [...block.slice(valuesAt).matchAll(/<span[^>]*>([^<]+)<\/span>/g)].map((m) => m[1])
	const value = htmlToText([...new Set(spans)].join(' '))
	return value ? [htmlToText(label), value] : null
}

// Parse the full detail set from a raw item page.
export function parseItemPage(html: string): ItemDetails {
	// Some page variants ship an empty <title> tag; the listing h1 is the fallback.
	const title = htmlToText(html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '')
		.replace(/\s*\|\s*eBay\s*$/, '') ||
		htmlToText(html.match(/x-item-title__mainTitle[\s\S]{0,200}?<span[^>]*>([^<]+)<\/span>/)?.[1] ?? '')

	const price = html.match(/"price"\s*:\s*\{[^}]*"value"\s*:\s*([\d.]+)/)?.[1] ??
		html.match(/US \$([\d,.]+)/)?.[1]?.replaceAll(',', '') ?? ''
	const currency = html.match(/"price"\s*:\s*\{[^}]*"currency"\s*:\s*"([A-Z]{3})"/)?.[1] ??
		(html.includes('US $') ? 'USD' : '')

	const availability = html.match(/(\d+)\s+available/)?.[1] ??
		(/Last one\b/i.test(html) ? '1' : '')

	// Gallery images live in the carousel; everything after it (recommendations,
	// similar items) is someone else's product.
	const carousel = html.match(/ux-image-carousel[\s\S]*?(?=Item specifics|x-sellercard|vim x-shop)/)?.[0] ?? ''
	const imageGroups = [
		...new Set([...carousel.matchAll(/i\.ebayimg\.com\/images\/g\/([A-Za-z0-9~_-]+)\//g)].map((m) => m[1])),
	]

	// Item specifics: the <dl> rows between the section heading and the description.
	const start = html.indexOf('Item specifics')
	const end = html.indexOf('Item description', start)
	const section = start >= 0 ? html.slice(start, end > start ? end : start + 80000) : ''
	const specifics = section.split('<dl').slice(1)
		.map(parseSpecificsRow)
		.filter((row): row is [string, string] => row !== null)
	const byLabel = new Map(specifics.map(([k, v]) => [k.toLowerCase(), v]))

	return {
		title,
		price,
		currency,
		availability,
		image_urls: imageGroups.map((g) => `https://i.ebayimg.com/images/g/${g}/s-l1600.jpg`).join(' | '),
		item_specifics: specifics.map(([k, v]) => `${k}: ${v}`).join(' | '),
		brand: byLabel.get('brand') ?? '',
		mpn: byLabel.get('manufacturer part number') ?? byLabel.get('mpn') ?? '',
	}
}
