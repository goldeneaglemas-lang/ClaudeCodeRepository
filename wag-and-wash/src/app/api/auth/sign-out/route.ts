import { NextResponse } from "next/server";
import { SESSION_COOKIE, endSession, isCrossSite, tokenFromRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** POST /api/auth/sign-out */
export async function POST(request: Request) {
  if (isCrossSite(request)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  await endSession(tokenFromRequest(request));
  const res = NextResponse.json({ signedIn: false });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
