export interface CheckoutRequest {
	readonly subtotalCents: number;
	readonly discountPercent: number;
}

export function calculateFinalPrice(request: CheckoutRequest): number {
	const finalPrice = request.subtotalCents - (request.subtotalCents * request.discountPercent / 100);
	return Math.max(finalPrice, 0);
}

export function checkout(request: CheckoutRequest): { totalCents: number } {
	return { totalCents: calculateFinalPrice(request) };
}

// Selects `calculateFinalPrice` when `useFinalPrice` is true, otherwise `checkout`.
// Returns 1 when the `calculateFinalPrice` branch was used (previously `true`),
// or 0 when the `checkout` branch was used (previously `false`).
export function processCheckout(useFinalPrice: boolean, ...args: any[]): 0 | 1 {
	if (useFinalPrice) {
		calculateFinalPrice(...args);
		return 1;
	}

	checkout(...args);
	return 0;
}
