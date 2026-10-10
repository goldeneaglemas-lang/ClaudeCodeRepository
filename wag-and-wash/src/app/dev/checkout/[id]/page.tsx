import { notFound } from "next/navigation";
import { formatCents } from "@/lib/money";
import { usingTestPayments } from "@/lib/payments";
import { TEST_CHECKOUT_PREFIX } from "@/lib/payments/test-provider";
import { prisma } from "@/lib/prisma";
import TestCheckoutButtons from "./TestCheckoutButtons";

export const dynamic = "force-dynamic";

/** Stands in for Stripe's payment page while there's no Stripe key. Never shown in production. */
export default async function TestCheckoutPage({ params }: { params: Promise<{ id: string }> }) {
  if (!usingTestPayments()) notFound();
  const { id } = await params;
  if (!id.startsWith(TEST_CHECKOUT_PREFIX)) notFound();

  const booking = await prisma.booking.findUnique({
    where: { stripeCheckoutId: id },
    select: { id: true, depositCents: true, service: { select: { name: true } } },
  });
  if (!booking) notFound();
  const success = `/book/done?booking=${booking.id}`;
  const cancel = `/book/cancelled?booking=${booking.id}`;

  return (
    <main>
      <p className="test-banner" role="note">
        Test payment page. No real money is taken. Stripe&apos;s page replaces this once a Stripe key is set.
      </p>
      <h1>Pay your deposit</h1>
      <p className="muted">Wag &amp; Wash · {booking.service.name}</p>
      <p className="amount">{formatCents(booking.depositCents)}</p>
      <TestCheckoutButtons checkoutId={id} successUrl={success} cancelUrl={cancel} amount={formatCents(booking.depositCents)} />
    </main>
  );
}
