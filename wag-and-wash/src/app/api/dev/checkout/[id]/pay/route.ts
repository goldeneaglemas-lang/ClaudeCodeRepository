import { NextResponse } from "next/server";
import { confirmDepositPaid } from "@/lib/bookings";
import { usingTestPayments } from "@/lib/payments";
import { TEST_CHECKOUT_PREFIX, testPaymentIntentId } from "@/lib/payments/test-provider";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * POST /api/dev/checkout/:id/pay: the test checkout's "Pay" button. Does what
 * Stripe's webhook would do. Only exists when no Stripe key is set, never in production.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!usingTestPayments()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { id } = await params;
  if (!id.startsWith(TEST_CHECKOUT_PREFIX)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const booking = await prisma.booking.findUnique({ where: { stripeCheckoutId: id } });
  if (!booking) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // Like Stripe, the page stops taking payment once the hold is over or released.
  if (booking.status !== "pending_payment" || (booking.holdExpiresAt && booking.holdExpiresAt <= new Date())) {
    return NextResponse.json({ error: "This payment page has expired." }, { status: 410 });
  }

  const result = await confirmDepositPaid({
    bookingId: booking.id,
    checkoutId: id,
    paymentIntentId: testPaymentIntentId(booking.id),
    amountCents: booking.depositCents,
    currency: "usd",
  });
  return NextResponse.json({ result });
}
