import Stripe from "stripe";
import type { Checkout, DepositCheckoutInput, PaymentProvider, RefundInput } from "./types";

let client: Stripe | null = null;

/** The Stripe API client. Needs STRIPE_SECRET_KEY. */
export function stripeClient(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set.");
  client ??= new Stripe(key);
  return client;
}

export const stripeProvider: PaymentProvider = {
  name: "stripe",

  async createDepositCheckout(input: DepositCheckoutInput): Promise<Checkout> {
    const session = await stripeClient().checkout.sessions.create(
      {
        mode: "payment",
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: input.amountCents,
              product_data: { name: "Wag & Wash deposit", description: input.description },
            },
          },
        ],
        client_reference_id: input.bookingId,
        metadata: { booking_id: input.bookingId },
        payment_intent_data: { description: input.description, metadata: { booking_id: input.bookingId } },
        customer_email: input.customerEmail ?? undefined,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        expires_at: Math.floor(input.expiresAt.getTime() / 1000),
      },
      { idempotencyKey: `checkout-${input.bookingId}` },
    );
    if (!session.url) throw new Error("Stripe didn't return a checkout URL.");
    return { id: session.id, url: session.url };
  },

  async expireCheckout(checkoutId: string): Promise<void> {
    const session = await stripeClient().checkout.sessions.retrieve(checkoutId);
    if (session.status === "open") await stripeClient().checkout.sessions.expire(checkoutId);
  },

  async refund(input: RefundInput): Promise<string> {
    const refund = await stripeClient().refunds.create(
      {
        payment_intent: input.paymentIntentId,
        amount: input.amountCents,
        metadata: { booking_id: input.bookingId, reason: input.reason },
      },
      // One refund per payment: a booking can need two (e.g. a duplicate payment, then a cancellation).
      { idempotencyKey: `refund-${input.paymentIntentId}` },
    );
    return refund.id;
  },
};

/** Checks a webhook really came from Stripe. Needs only STRIPE_WEBHOOK_SECRET, not the API key. */
export async function verifyStripeWebhook(body: string, signature: string, secret: string): Promise<Stripe.Event> {
  const verifier = client ?? new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_webhook_verification_only");
  return verifier.webhooks.constructEventAsync(body, signature, secret);
}
