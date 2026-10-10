import type { Metadata } from "next";
import Link from "next/link";
import { listBookings } from "@/lib/account";
import { balanceDueCents, formatCents } from "@/lib/money";
import { formatUsPhone } from "@/lib/phone";
import { isRefundable, refundDeadline } from "@/lib/policy";
import { currentCustomer } from "@/lib/session";
import { getSettings } from "@/lib/slots";
import { formatDateLong, formatTime } from "@/lib/time";
import { CancelBooking, DogEditor, ReminderToggle, SignInPanel, SignOutButton } from "./client";

export const metadata: Metadata = { title: "My bookings · Wag & Wash" };
export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  confirmed: "Booked",
  completed: "Done",
  cancelled: "Cancelled",
  no_show: "Missed",
};

export default async function MyBookingsPage() {
  const me = await currentCustomer();
  if (!me) {
    return (
      <main>
        <h1>My bookings</h1>
        <SignInPanel />
      </main>
    );
  }

  const now = new Date();
  const [{ upcoming, past }, settings] = await Promise.all([listBookings(me.phone, now), getSettings()]);
  const tz = settings.timezone;
  const when = (d: Date) => `${formatDateLong(d, tz)}, ${formatTime(d, tz)}`;

  return (
    <main>
      <h1>My bookings</h1>
      <p className="muted">
        Signed in as {formatUsPhone(me.phone)} · <SignOutButton />
      </p>

      <section className="account-section" aria-labelledby="upcoming">
        <h2 id="upcoming" className="step">Upcoming</h2>
        {upcoming.length === 0 ? (
          <p className="muted">
            No upcoming appointments. <Link href="/book">Book one</Link>
          </p>
        ) : (
          <ul className="booking-list">
            {upcoming.map((b) => {
              const refundable = isRefundable(b.startsAt, now, settings.cancellationDays);
              const deadline = refundDeadline(b.startsAt, settings.cancellationDays);
              return (
                <li key={b.id} className="booking-card">
                  <h3>
                    {b.dog.name}: {b.service.name}
                  </h3>
                  <p className="when">{when(b.startsAt)}</p>
                  <dl>
                    <dt>Deposit paid</dt>
                    <dd>{formatCents(b.depositCents)}</dd>
                    <dt>Pay on the day</dt>
                    <dd>{formatCents(balanceDueCents(b.priceCents, b.depositCents))}</dd>
                  </dl>
                  <p className="small muted">
                    {refundable
                      ? `Cancel by ${when(deadline)} for a full refund of your deposit.`
                      : "The deposit for this appointment can't be refunded."}
                  </p>
                  <CancelBooking bookingId={b.id} refundable={refundable} deposit={formatCents(b.depositCents)} />
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {past.length > 0 && (
        <section className="account-section" aria-labelledby="past">
          <h2 id="past" className="step">Past and cancelled</h2>
          <ul className="booking-list">
            {past.map((b) => {
              const refunded = b.payments.some((p) => p.type === "refund" && p.status === "succeeded");
              return (
                <li key={b.id} className="booking-card past">
                  <div>
                    <h3>
                      {b.dog.name}: {b.service.name}
                    </h3>
                    <p className="when">{when(b.startsAt)}</p>
                    <p className="small muted">
                      {STATUS_LABEL[b.status] ?? b.status}
                      {b.status === "cancelled" && (refunded ? " · deposit refunded" : " · deposit kept")}
                    </p>
                  </div>
                  <Link className="small nowrap" href={`/book?service=${b.service.id}`}>
                    Book again
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {me.dogs.length > 0 && (
        <section className="account-section" aria-labelledby="dogs">
          <h2 id="dogs" className="step">My dogs</h2>
          <ul className="booking-list">
            {me.dogs.map((d) => (
              <li key={d.id} className="booking-card">
                <DogEditor dog={d} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {me.name && (
        <section className="account-section" aria-labelledby="texts">
          <h2 id="texts" className="step">Texts</h2>
          <ReminderToggle initial={me.smsOptIn} />
        </section>
      )}
    </main>
  );
}
