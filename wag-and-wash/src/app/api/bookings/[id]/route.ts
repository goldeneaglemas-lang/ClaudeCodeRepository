import { NextResponse } from "next/server";
import { getBookingSummary } from "@/lib/bookings";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/bookings/:id: status for the "you're booked" page while it waits
 * for the payment to be confirmed. The id is an unguessable UUID only the
 * customer has, and the reply holds no personal details.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const booking = await getBookingSummary(id);
  if (!booking) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ status: booking.status }, { headers: { "Cache-Control": "no-store" } });
}
