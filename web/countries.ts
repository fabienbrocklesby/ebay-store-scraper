// Shipping destinations the app offers. The code doubles as the Zyte
// geolocation value, and the currency is what the CSV gets converted into.

export interface ShipOption {
	code: string // ISO 3166-1 alpha-2, also the Zyte geolocation value
	label: string
	currency: string // ISO 4217, the CSV output currency for this destination
}

export const SHIP_OPTIONS: ShipOption[] = [
	{ code: 'NZ', label: 'New Zealand', currency: 'NZD' },
	{ code: 'AU', label: 'Australia', currency: 'AUD' },
	{ code: 'US', label: 'United States', currency: 'USD' },
	{ code: 'CA', label: 'Canada', currency: 'CAD' },
	{ code: 'GB', label: 'United Kingdom', currency: 'GBP' },
]

export function shipOption(code: string | null | undefined): ShipOption | null {
	return SHIP_OPTIONS.find((o) => o.code === code) ?? null
}
