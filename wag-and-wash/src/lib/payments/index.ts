import { stripeProvider } from "./stripe";
import { testProvider } from "./test-provider";
import type { PaymentProvider } from "./types";

export type { PaymentProvider } from "./types";

/** True when the built-in test checkout is in use instead of Stripe. Never in production. */
export function usingTestPayments(): boolean {
  return !process.env.STRIPE_SECRET_KEY && process.env.NODE_ENV !== "production";
}

export function paymentProvider(): PaymentProvider {
  if (process.env.STRIPE_SECRET_KEY) return stripeProvider;
  if (usingTestPayments()) return testProvider;
  throw new Error("STRIPE_SECRET_KEY must be set in production.");
}
