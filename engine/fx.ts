// Currency conversion for the CSV export. The rates file is written by the
// web server when a job has a shipping country (one free API call); the
// engine only ever reads it. Pure logic, tested in fx_test.ts.

export interface FxRates {
	base: string // e.g. 'USD'
	rates: Record<string, number> // units of each currency per 1 base unit
}

export function loadRates(path: string): FxRates | null {
	try {
		const fx = JSON.parse(Deno.readTextFileSync(path)) as FxRates
		if (typeof fx.base !== 'string' || typeof fx.rates !== 'object' || fx.rates === null) return null
		return fx
	} catch {
		return null
	}
}

// Convert an amount between currencies, or null when a rate is unknown.
export function convert(amount: number, from: string, to: string, fx: FxRates): number | null {
	if (!Number.isFinite(amount)) return null
	if (from === to) return amount
	const rateFrom = from === fx.base ? 1 : fx.rates[from]
	const rateTo = to === fx.base ? 1 : fx.rates[to]
	if (!rateFrom || !rateTo) return null
	return Math.round((amount / rateFrom) * rateTo * 100) / 100
}
