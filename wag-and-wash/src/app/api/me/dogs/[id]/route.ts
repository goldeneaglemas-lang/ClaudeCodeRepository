import { NextResponse } from "next/server";
import { updateDog } from "@/lib/account";
import { isCrossSite, phoneFromRequest } from "@/lib/auth";
import { NewDog, UUID_RE } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** PATCH /api/me/dogs/:id: edit one of the signed-in customer's dogs. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (isCrossSite(request)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const phone = await phoneFromRequest(request);
  if (!phone) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { id } = await params;
  const parsed = NewDog.safeParse(await request.json().catch(() => null));
  if (!UUID_RE.test(id) || !parsed.success) return NextResponse.json({ error: "Please check the dog's details." }, { status: 400 });
  const ok = await updateDog(phone, id, parsed.data);
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Dog not found" }, { status: 404 });
}
