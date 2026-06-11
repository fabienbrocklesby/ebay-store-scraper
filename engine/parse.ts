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
