import { NextResponse } from "next/server";
import { releaseHold } from "@/lib/bookings";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** POST /api/bookings/:id/release: the customer left the payment page, so free the time. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (UUID_RE.test(id)) await releaseHold(id);
  return NextResponse.json({ ok: true });
}
