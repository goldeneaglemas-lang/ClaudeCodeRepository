import { NextResponse } from "next/server";
import { getAccount } from "@/lib/account";
import { phoneFromRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** GET /api/me: the signed-in customer's details and dogs (for the booking form). */
export async function GET(request: Request) {
  const phone = await phoneFromRequest(request);
  if (!phone) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const account = await getAccount(phone);
  return NextResponse.json(
    {
      phone,
      name: account?.name ?? "",
      email: account?.email ?? "",
      smsOptIn: account?.smsOptIn ?? true,
      dogs: (account?.dogs ?? []).map((d) => ({ id: d.id, name: d.name, breed: d.breed, size: d.size, notes: d.notes })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
