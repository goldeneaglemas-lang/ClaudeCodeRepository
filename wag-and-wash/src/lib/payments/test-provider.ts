// A stand-in for Stripe, used when STRIPE_SECRET_KEY isn't set. Its checkout
// "page" is /dev/checkout/<id> in this app, with Pay and Cancel buttons; no
// money moves. It is never used in production (see ./index.ts).
import type { Checkout, DepositCheckoutInput, PaymentProvider, RefundInput } from "./types";

export const TEST_CHECKOUT_PREFIX = "test_cs_";

export const testProvider: PaymentProvider = {
  name: "test",

  async createDepositCheckout(input: DepositCheckoutInput): Promise<Checkout> {
    // The test page works out where to send the customer back to from the
    // booking itself, so it never trusts a return address in the link.
    const id = `${TEST_CHECKOUT_PREFIX}${input.bookingId}`;
    return { id, url: `/dev/checkout/${id}` };
  },

  async expireCheckout(): Promise<void> {},

  async refund(input: RefundInput): Promise<string> {
    return `test_re_${input.paymentIntentId}`;
  },
};

/** The payment id the test checkout reports when "paid". */
export function testPaymentIntentId(bookingId: string): string {
  return `test_pi_${bookingId}`;
}
