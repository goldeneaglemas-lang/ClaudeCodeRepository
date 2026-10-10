import { NextResponse } from "next/server";
import { phoneFromRequest } from "@/lib/auth";
import { releaseHold } from "@/lib/bookings";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** POST /api/bookings/:id/release: the customer left the payment page, so free the time. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const phone = await phoneFromRequest(request);
  if (!phone || !UUID_RE.test(id)) return NextResponse.json({ ok: true });
  // Only the customer who made the hold can release it.
  const mine = await prisma.booking.findFirst({ where: { id, customer: { phone } }, select: { id: true } });
  if (mine) await releaseHold(id);
  return NextResponse.json({ ok: true });
}
