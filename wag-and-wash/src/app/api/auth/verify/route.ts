import { NextResponse } from "next/server";
import { AuthError, isCrossSite, sessionCookie, verifyLoginCode } from "@/lib/auth";
import { normalizeUsPhone } from "@/lib/phone";

export const dynamic = "force-dynamic";

/** POST /api/auth/verify { phone, code }: check the code and sign the customer in. */
export async function POST(request: Request) {
  if (isCrossSite(request)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await request.json().catch(() => null);
  const phone = normalizeUsPhone(String(body?.phone ?? ""));
  const code = String(body?.code ?? "").replace(/\s/g, "");
  if (!phone) return NextResponse.json({ error: "Please enter a 10-digit US mobile number." }, { status: 400 });

  try {
    const { token, expiresAt } = await verifyLoginCode(phone, code);
    const res = NextResponse.json({ signedIn: true });
    res.cookies.set(sessionCookie(token, expiresAt));
    return res;
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
