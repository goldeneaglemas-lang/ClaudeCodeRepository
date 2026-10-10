import { NextResponse } from "next/server";
import { AuthError, clientIp, isCrossSite, sendLoginCode } from "@/lib/auth";
import { normalizeUsPhone } from "@/lib/phone";

export const dynamic = "force-dynamic";

/** POST /api/auth/code { phone }: text a 6-digit sign-in code. */
export async function POST(request: Request) {
  if (isCrossSite(request)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await request.json().catch(() => null);
  const phone = normalizeUsPhone(String(body?.phone ?? ""));
  if (!phone) return NextResponse.json({ error: "Please enter a 10-digit US mobile number." }, { status: 400 });

  try {
    const { devCode } = await sendLoginCode(phone, clientIp(request));
    return NextResponse.json({ sent: true, phone, ...(devCode ? { devCode } : {}) });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.code === "too_many_codes" ? 429 : 502 });
    }
    throw e;
  }
}
