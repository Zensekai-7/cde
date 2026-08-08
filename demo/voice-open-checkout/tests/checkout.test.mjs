import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateFinalPrice, checkout } from '../src/checkout.ts';

test('applies a percentage discount', () => {
	assert.equal(calculateFinalPrice({ subtotalCents: 10_000, discountPercent: 20 }), 8_000);
});

test('prevents discounts from producing a negative price', () => {
	assert.equal(calculateFinalPrice({ subtotalCents: 10_000, discountPercent: 150 }), 0);
});

test('returns the calculated total from checkout', () => {
	assert.deepEqual(checkout({ subtotalCents: 5_000, discountPercent: 10 }), { totalCents: 4_500 });
});
