// What the booking code needs from a payment provider. Real Stripe in
// production; a built-in test stand-in when no Stripe key is set (dev, tests).

export type DepositCheckoutInput = {
  bookingId: string;
  amountCents: number;
  description: string; // shown on the payment page, e.g. "Deposit: Full Groom, Tue Nov 3, 10:00 AM"
  customerEmail?: string | null;
  successUrl: string;
  cancelUrl: string;
  expiresAt: Date; // the checkout page stops accepting payment after this
};

export type Checkout = { id: string; url: string };

export type RefundInput = {
  paymentIntentId: string;
  amountCents: number;
  bookingId: string;
  reason: string;
};

export interface PaymentProvider {
  readonly name: "stripe" | "test";
  createDepositCheckout(input: DepositCheckoutInput): Promise<Checkout>;
  /** Stop a checkout page from taking payment (customer backed out). Safe to call twice. */
  expireCheckout(checkoutId: string): Promise<void>;
  /** Returns the refund's id. Safe to retry: the same payment is never refunded twice. */
  refund(input: RefundInput): Promise<string>;
}
