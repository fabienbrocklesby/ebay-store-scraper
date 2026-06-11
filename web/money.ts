// Dollars to Zyte requests and back. Users think in dollars; the engine's
// budget stop thinks in requests. The bridge is the measured blended rate
// (~$0.12 per 1,000 requests on the live account, June 2026), configurable via
// COST_PER_1K_USD because it shifts with Zyte commitment tiers.
//
// Pure functions, tested in money_test.ts.

export function dollarsToRequests(dollars: number, ratePer1k: number): number {
	if (!Number.isFinite(dollars) || dollars <= 0 || ratePer1k <= 0) return 0
	// Floor of 1,000 requests so a typo like $0.001 still buys a usable run.
	return Math.max(1000, Math.round((dollars / ratePer1k) * 1000))
}

export function requestsToDollars(requests: number, ratePer1k: number): number {
	return (requests * ratePer1k) / 1000
}

export function formatDollars(d: number): string {
	if (d < 0.01) return 'less than a cent'
	if (d < 100) return `$${d.toFixed(d % 1 === 0 ? 0 : 2)}`
	return `$${Math.round(d).toLocaleString('en-US')}`
}
