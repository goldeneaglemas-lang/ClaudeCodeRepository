import type { Metadata } from "next";
import Link from "next/link";
import ReleaseHold from "./ReleaseHold";

export const metadata: Metadata = { title: "Payment cancelled · Wag & Wash" };

export default async function CancelledPage({ searchParams }: { searchParams: Promise<{ booking?: string }> }) {
  const { booking } = await searchParams;
  return (
    <main>
      <h1>No payment taken</h1>
      <p>You left the payment page, so the time isn&apos;t booked and nothing was charged.</p>
      {booking && <ReleaseHold bookingId={booking} />}
      <Link className="button" href="/book">
        Pick a time again
      </Link>
    </main>
  );
}
