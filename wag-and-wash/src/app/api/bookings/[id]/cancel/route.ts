import { NextResponse } from "next/server";
import { CancelError, cancelBookingByCustomer } from "@/lib/account";
import { isCrossSite, phoneFromRequest } from "@/lib/auth";
import { UUID_RE } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** POST /api/bookings/:id/cancel: the signed-in customer cancels; refunded if 10+ days ahead. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (isCrossSite(request)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const phone = await phoneFromRequest(request);
  if (!phone) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Booking not found." }, { status: 404 });

  try {
    const result = await cancelBookingByCustomer(id, phone);
    return NextResponse.json({ cancelled: true, ...result });
  } catch (e) {
    if (e instanceof CancelError) {
      return NextResponse.json({ error: e.message }, { status: e.code === "not_found" ? 404 : 409 });
    }
    throw e;
  }
}
