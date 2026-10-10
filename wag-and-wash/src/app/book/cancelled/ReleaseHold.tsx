"use client";

import { useEffect } from "react";

/** Frees the held time straight away, instead of keeping it blocked until the hold runs out. */
export default function ReleaseHold({ bookingId }: { bookingId: string }) {
  useEffect(() => {
    fetch(`/api/bookings/${encodeURIComponent(bookingId)}/release`, { method: "POST" }).catch(() => {});
  }, [bookingId]);
  return null;
}
