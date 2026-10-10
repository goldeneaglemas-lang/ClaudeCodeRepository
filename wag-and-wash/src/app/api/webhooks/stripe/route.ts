import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { confirmDepositPaid, handleCheckoutExpired } from "@/lib/bookings";
import { verifyStripeWebhook } from "@/lib/payments/stripe";

export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/stripe (PLAN.md §5.3).
 * 400 for a bad signature; 500 if handling fails, so Stripe retries later.
 */
export async function POST(request: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error("STRIPE_WEBHOOK_SECRET is not set");
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });
  }
  const signature = request.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "Missing signature" }, { status: 400 });

  let event: Stripe.Event;
  try {
    event = await verifyStripeWebhook(await request.text(), signature, secret);
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const session = event.data.object;
        if (session.payment_status !== "paid") break; // not paid yet; a later event follows
        const bookingId = session.metadata?.booking_id ?? session.client_reference_id;
        const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
        if (!bookingId || !paymentIntentId) {
          console.error("Checkout session without booking or payment id", session.id);
          break;
        }
        const result = await confirmDepositPaid({
          bookingId,
          checkoutId: session.id,
          paymentIntentId,
          amountCents: session.amount_total ?? 0,
          currency: session.currency ?? "",
        });
        return NextResponse.json({ received: true, result });
      }
      case "checkout.session.expired":
        await handleCheckoutExpired(event.data.object.id);
        break;
    }
    return NextResponse.json({ received: true });
  } catch (e) {
    console.error("Stripe webhook failed", event.id, e);
    return NextResponse.json({ error: "Webhook handling failed" }, { status: 500 });
  }
}
