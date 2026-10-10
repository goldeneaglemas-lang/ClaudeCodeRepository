import { NextResponse } from "next/server";
import { z } from "zod";
import { isCrossSite, phoneFromRequest } from "@/lib/auth";
import { baseUrl } from "@/lib/base-url";
import { BookingError, createBookingHold } from "@/lib/bookings";
import { NewDog, text } from "@/lib/validation";

export const dynamic = "force-dynamic";

const Body = z.object({
  serviceId: z.string().uuid(),
  startsAt: z.string().datetime(),
  customer: z.object({
    name: text(100),
    email: z.union([z.literal(""), z.string().trim().email().max(200)]).optional().nullable(),
  }),
  dog: z.union([z.object({ id: z.string().uuid() }), NewDog]),
  acceptNonRefundable: z.boolean().default(false),
});

const STATUS: Record<BookingError["code"], number> = {
  slot_unavailable: 409,
  slot_taken: 409,
  needs_non_refundable_ok: 422,
  dog_not_found: 400,
  payment_setup_failed: 502,
};

/**
 * POST /api/bookings: hold a time and get the deposit payment page.
 * Needs a signed-in customer; their verified phone is used, never one from the form.
 * Returns 201 { bookingId, checkoutUrl }; 401 if not signed in; 409 if the time has gone.
 */
export async function POST(request: Request) {
  if (isCrossSite(request)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const phone = await phoneFromRequest(request);
  if (!phone) return NextResponse.json({ error: "Please confirm your phone number first." }, { status: 401 });

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Please check the form and try again.", fields: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const input = parsed.data;

  try {
    const result = await createBookingHold(
      {
        serviceId: input.serviceId,
        startsAt: new Date(input.startsAt),
        customer: { ...input.customer, phone },
        dog: input.dog,
        acceptNonRefundable: input.acceptNonRefundable,
      },
      { baseUrl: baseUrl(request) },
    );
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    if (e instanceof BookingError) return NextResponse.json({ error: e.message, code: e.code }, { status: STATUS[e.code] });
    throw e;
  }
}
