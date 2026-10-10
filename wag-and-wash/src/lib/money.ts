/** Formats cents as dollars, e.g. 5500 -> "$55.00". */
export function formatCents(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

/** What the customer still owes on the day. The deposit comes off the final price. */
export function balanceDueCents(priceCents: number, depositCents: number): number {
  return Math.max(priceCents - depositCents, 0);
}
