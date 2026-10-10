import type { Metadata } from "next";
import Link from "next/link";
import { getBookingSummary } from "@/lib/bookings";
import { balanceDueCents, formatCents } from "@/lib/money";
import { refundDeadline } from "@/lib/policy";
import { getSettings } from "@/lib/slots";
import { formatDateLong, formatTime } from "@/lib/time";
import WaitForPayment from "./WaitForPayment";

export const metadata: Metadata = { title: "Your booking · Wag & Wash" };
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function DonePage({ searchParams }: { searchParams: Promise<{ booking?: string }> }) {
  const { booking: id } = await searchParams;
  const booking = id && UUID_RE.test(id) ? await getBookingSummary(id) : null;

  if (!booking) {
    return (
      <main>
        <h1>Booking not found</h1>
        <p>
          <Link href="/book">Make a booking</Link>
        </p>
      </main>
    );
  }

  const { timezone, cancellationDays } = await getSettings();
  const when = `${formatDateLong(booking.startsAt, timezone)}, ${formatTime(booking.startsAt, timezone)}`;

  if (booking.status === "pending_payment") {
    return (
      <main>
        <h1>Confirming your payment…</h1>
        <p className="muted">This usually takes a few seconds.</p>
        <WaitForPayment bookingId={booking.id} />
      </main>
    );
  }

  if (booking.status !== "confirmed" && booking.status !== "completed") {
    return (
      <main>
        <h1>This booking isn&apos;t active</h1>
        <p>
          The time for {booking.service.name} on {when} is no longer held. If you were charged, the deposit is refunded
          automatically.
        </p>
        <Link className="button" href="/book">
          Choose another time
        </Link>
      </main>
    );
  }

  const deadline = refundDeadline(booking.startsAt, cancellationDays);
  return (
    <main>
      <h1>You&apos;re booked! 🐾</h1>
      <p>
        {booking.dog.name}&apos;s {booking.service.name} is on <strong>{when}</strong>.
      </p>
      <div className="summary">
        <dl>
          <dt>Deposit paid</dt>
          <dd>{formatCents(booking.depositCents)}</dd>
          <dt>Pay on the day</dt>
          <dd>{formatCents(balanceDueCents(booking.priceCents, booking.depositCents))}</dd>
        </dl>
        <p className="note">
          {deadline > new Date()
            ? `Need to cancel? Do it by ${formatDateLong(deadline, timezone)}, ${formatTime(deadline, timezone)} for a full refund of your deposit.`
            : "This deposit can't be refunded if you cancel."}
        </p>
      </div>
      <p className="muted">We&apos;ll text you a reminder the day before.</p>
      <Link href="/">Back to Wag &amp; Wash</Link>
    </main>
  );
}
