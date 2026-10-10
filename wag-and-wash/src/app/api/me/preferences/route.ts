import { NextResponse } from "next/server";
import { setReminderTexts } from "@/lib/account";
import { isCrossSite, phoneFromRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** PATCH /api/me/preferences { smsOptIn }: turn reminder texts on or off. */
export async function PATCH(request: Request) {
  if (isCrossSite(request)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const phone = await phoneFromRequest(request);
  if (!phone) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const body = await request.json().catch(() => null);
  if (typeof body?.smsOptIn !== "boolean") return NextResponse.json({ error: "smsOptIn must be true or false" }, { status: 400 });
  const ok = await setReminderTexts(phone, body.smsOptIn);
  return ok ? NextResponse.json({ smsOptIn: body.smsOptIn }) : NextResponse.json({ error: "No account yet" }, { status: 404 });
}
