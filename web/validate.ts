// Validation and normalization for the uploaded stores file.
//
// One eBay store per line. Accepted forms, all normalized to
// https://www.ebay.com/str/{slug}:
//
//   https://www.ebay.com/str/storename
//   http://ebay.com/str/storename/          (scheme and www optional, trailing slash ok)
//   www.ebay.com/str/storename?_tab=about   (query strings ignored)
//   https://www.ebay.com/str/storename/Lights/_i.html  (category pages collapse to the store)
//   storename                               (bare slug)
//
// Anything else is rejected with the line number and a plain-language message.
// Pure functions, no IO: tested in validate_test.ts.

export interface LineError {
	line: number
	text: string
	message: string
}

export interface StoresFileResult {
	stores: string[] // normalized store URLs, deduplicated, in input order
	errors: LineError[]
	duplicates: number // how many valid lines were dropped as repeats
}

const EXAMPLE = 'Expected something like https://www.ebay.com/str/storename'

// eBay store slugs: letters, digits, dots, underscores, hyphens.
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const EBAY_HOSTS = new Set(['ebay.com', 'www.ebay.com'])

const storeURL = (slug: string) => `https://www.ebay.com/str/${slug}`

// Extract the store slug from a single trimmed line, or return an error message.
function slugFromLine(text: string): { slug?: string; problem?: string } {
	// Bare slug: no slashes, no dots-that-look-like-a-domain ambiguity beyond the
	// slug charset itself.
	if (!text.includes('/') && !text.includes(':') && SLUG_RE.test(text)) {
		return { slug: text }
	}

	// Tolerate a missing scheme so "www.ebay.com/str/x" works.
	const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text) ? text : `https://${text}`

	let url: URL
	try {
		url = new URL(withScheme)
	} catch {
		return { problem: `is not an eBay store link. ${EXAMPLE}` }
	}

	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		return { problem: `is not an eBay store link. ${EXAMPLE}` }
	}

	const host = url.hostname.toLowerCase()
	if (!EBAY_HOSTS.has(host)) {
		if (host.endsWith('.ebay.com') || /(^|\.)ebay\.[a-z.]+$/.test(host)) {
			return {
				problem: `points at ${host}, but only www.ebay.com store links are supported. ${EXAMPLE}`,
			}
		}
		return { problem: `is not an eBay link. ${EXAMPLE}` }
	}

	const segments = url.pathname.split('/').filter(Boolean)
	if (segments.length < 2 || segments[0].toLowerCase() !== 'str') {
		return { problem: `is an eBay link but not a store link. ${EXAMPLE}` }
	}

	const slug = segments[1]
	if (!SLUG_RE.test(slug)) {
		return { problem: `has a store name with unexpected characters. ${EXAMPLE}` }
	}
	return { slug }
}

// Parse the whole uploaded file. Blank lines are skipped; every other line must
// be a store. Valid repeats of the same store are silently merged and counted.
export function parseStoresFile(content: string): StoresFileResult {
	const stores: string[] = []
	const errors: LineError[] = []
	const seen = new Set<string>()
	let duplicates = 0

	const lines = content.split(/\r?\n/)
	for (let i = 0; i < lines.length; i++) {
		const text = lines[i].trim()
		if (!text) continue

		const { slug, problem } = slugFromLine(text)
		if (!slug) {
			errors.push({ line: i + 1, text, message: `Line ${i + 1} ${problem}` })
			continue
		}

		const key = slug.toLowerCase()
		if (seen.has(key)) {
			duplicates++
			continue
		}
		seen.add(key)
		stores.push(storeURL(slug))
	}

	return { stores, errors, duplicates }
}
