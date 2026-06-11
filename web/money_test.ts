import { assertEquals } from '@std/assert'
import { dollarsToRequests, formatDollars, requestsToDollars } from './money.ts'

Deno.test('dollarsToRequests converts at the configured rate', () => {
	assertEquals(dollarsToRequests(120, 0.12), 1_000_000)
	assertEquals(dollarsToRequests(1, 0.12), 8333)
	assertEquals(dollarsToRequests(12, 0.24), 50_000)
})

Deno.test('dollarsToRequests floors tiny budgets at 1,000 requests', () => {
	assertEquals(dollarsToRequests(0.01, 0.12), 1000)
})

Deno.test('dollarsToRequests rejects junk input', () => {
	assertEquals(dollarsToRequests(0, 0.12), 0)
	assertEquals(dollarsToRequests(-5, 0.12), 0)
	assertEquals(dollarsToRequests(NaN, 0.12), 0)
	assertEquals(dollarsToRequests(10, 0), 0)
})

Deno.test('requestsToDollars and formatting', () => {
	assertEquals(formatDollars(requestsToDollars(1_000_000, 0.12)), '$120')
	assertEquals(formatDollars(requestsToDollars(25_300, 0.12)), '$3.04')
	assertEquals(formatDollars(requestsToDollars(30, 0.12)), 'less than a cent')
	assertEquals(formatDollars(0.5), '$0.50')
	assertEquals(formatDollars(5), '$5')
	assertEquals(formatDollars(1234), '$1,234')
})
