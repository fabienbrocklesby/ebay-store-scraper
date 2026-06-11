import { assertEquals } from '@std/assert'
import { convert, type FxRates } from './fx.ts'

const FX: FxRates = { base: 'USD', rates: { USD: 1, NZD: 1.64, GBP: 0.79 } }

Deno.test('converts between currencies through the base', () => {
	assertEquals(convert(100, 'USD', 'NZD', FX), 164)
	assertEquals(convert(164, 'NZD', 'USD', FX), 100)
	assertEquals(convert(79, 'GBP', 'NZD', FX), 164)
})

Deno.test('same currency is a no-op and unknown rates return null', () => {
	assertEquals(convert(42.5, 'NZD', 'NZD', FX), 42.5)
	assertEquals(convert(10, 'JPY', 'NZD', FX), null)
	assertEquals(convert(NaN, 'USD', 'NZD', FX), null)
})

Deno.test('rounds to cents', () => {
	assertEquals(convert(18.16, 'USD', 'NZD', FX), 29.78)
})
