import { NextResponse } from "next/server";
import { expireStaleHolds } from "@/lib/bookings";

export const dynamic = "force-dynamic";

/**
 * GET /api/cron/expire-holds: frees slots whose deposit was never paid
 * (PLAN.md §5.4). Run every few minutes by the host's scheduler, which sends
 * "Authorization: Bearer $CRON_SECRET". Booking also clears stale holds
 * itself, so a missed run never blocks a customer.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret && process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "CRON_SECRET is not set" }, { status: 500 });
  }
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const expired = await expireStaleHolds();
  return NextResponse.json({ expired });
}
