import { NextResponse } from "next/server";
import { z } from "zod";
import { baseUrl } from "@/lib/base-url";
import { BookingError, createBookingHold } from "@/lib/bookings";
import { normalizeUsPhone } from "@/lib/phone";

export const dynamic = "force-dynamic";

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional().nullable();

const Body = z.object({
  serviceId: z.string().uuid(),
  startsAt: z.string().datetime(),
  customer: z.object({
    name: text(100),
    phone: z.string().max(30),
    email: z.union([z.literal(""), z.string().trim().email().max(200)]).optional().nullable(),
  }),
  dog: z.object({
    name: text(60),
    breed: optionalText(60),
    size: z.enum(["small", "medium", "large", "xl"]),
    notes: optionalText(1000),
  }),
  acceptNonRefundable: z.boolean().default(false),
});

const STATUS: Record<BookingError["code"], number> = {
  slot_unavailable: 409,
  slot_taken: 409,
  needs_non_refundable_ok: 422,
  payment_setup_failed: 502,
};

/**
 * POST /api/bookings: hold a time and get the deposit payment page.
 * Returns 201 { bookingId, checkoutUrl }; 409 if the time has gone.
 */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Please check the form and try again.", fields: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const input = parsed.data;
  const phone = normalizeUsPhone(input.customer.phone);
  if (!phone) return NextResponse.json({ error: "Please enter a 10-digit US mobile number." }, { status: 400 });

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
