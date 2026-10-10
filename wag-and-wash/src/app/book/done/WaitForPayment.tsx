"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/** Stripe's webhook can land a moment after the customer returns; check every 2s for up to a minute. */
export default function WaitForPayment({ bookingId }: { bookingId: string }) {
  const router = useRouter();
  const [gaveUp, setGaveUp] = useState(false);

  useEffect(() => {
    let tries = 0;
    const timer = setInterval(async () => {
      tries += 1;
      const res = await fetch(`/api/bookings/${bookingId}`, { cache: "no-store" }).catch(() => null);
      const status = res?.ok ? (await res.json()).status : null;
      if (status && status !== "pending_payment") {
        clearInterval(timer);
        router.refresh();
      } else if (tries >= 30) {
        clearInterval(timer);
        setGaveUp(true);
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [bookingId, router]);

  return gaveUp ? (
    <p role="alert">
      We haven&apos;t heard back from the payment provider yet. If you paid, you&apos;ll get a text when it&apos;s confirmed;
      or refresh this page in a minute.
    </p>
  ) : (
    <p className="spinner" aria-live="polite">
      Waiting for confirmation
    </p>
  );
}
