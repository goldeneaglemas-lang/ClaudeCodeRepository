// Booking and paying the deposit (PLAN.md §5.2–5.4).
//
// 1. createBookingHold: check the time is really free, hold it as
//    `pending_payment`, and open a checkout page for the $25 deposit.
// 2. confirmDepositPaid: called by the Stripe webhook (or the test checkout)
//    once the money arrives. Safe to call more than once.
// 3. Holds that are never paid run out and are marked `expired`.
import { Prisma, type Booking, type DogSize } from "@prisma/client";
import { prisma } from "./prisma";
import { paymentProvider } from "./payments";
import { isRefundable } from "./policy";
import { getSettings, getSlots } from "./slots";
import { MINUTE, formatDateLong, formatTime, localDate } from "./time";

export type NewDog = { name: string; breed?: string | null; size: DogSize; notes?: string | null };

export type NewBookingInput = {
  serviceId: string;
  startsAt: Date;
  // The phone is the customer's verified sign-in phone (E.164), never typed-in data.
  customer: { name: string; phone: string; email?: string | null };
  dog: { id: string } | NewDog; // one of their saved dogs, or a new one
  acceptNonRefundable: boolean;
};

export class BookingError extends Error {
  constructor(
    readonly code: "slot_unavailable" | "slot_taken" | "needs_non_refundable_ok" | "payment_setup_failed" | "dog_not_found",
    message: string,
  ) {
    super(message);
  }
}

/** True if Postgres refused the insert because the time overlaps another booking. */
export function isOverlapError(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? e);
  return msg.includes("bookings_no_overlap") || msg.includes("23P01");
}

class StatusChanged extends Error {}

function isUniqueError(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

/**
 * Lets one booking change Jess's calendar at a time, until its transaction ends.
 * Inserts that race for the same slot can deadlock inside the no-overlap
 * check (seen in tests/booking-constraints.test.ts); Postgres takes a second
 * or more to give up on one, and it surfaces as an error, not "slot taken".
 * The rest of the booking work makes that rare here; this rules it out.
 * With one calendar, the wait is milliseconds.
 */
export async function lockCalendar(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(7242001)");
}

/** Marks unpaid holds whose time has run out as expired, freeing their slots. */
export async function expireStaleHolds(now = new Date(), db: Prisma.TransactionClient = prisma): Promise<number> {
  const { count } = await db.booking.updateMany({
    where: { status: "pending_payment", holdExpiresAt: { lte: now } },
    data: { status: "expired" },
  });
  return count;
}

/** Holds the slot and returns the checkout page URL for the deposit. */
export async function createBookingHold(
  input: NewBookingInput,
  opts: { baseUrl: string; now?: Date },
): Promise<{ bookingId: string; checkoutUrl: string }> {
  const now = opts.now ?? new Date();
  const settings = await getSettings();
  const tz = settings.timezone;

  // The server decides what's bookable, never the browser: the time must be
  // one the slot finder offers right now (open, not taken, enough notice...).
  const date = localDate(input.startsAt, tz);
  const days = await getSlots(input.serviceId, date, date, now);
  const offered = days?.[0]?.slots.some((s) => s.startsAt === input.startsAt.toISOString());
  if (!offered) throw new BookingError("slot_unavailable", "Sorry, that time isn't available. Please pick another.");

  if (!isRefundable(input.startsAt, now, settings.cancellationDays) && !input.acceptNonRefundable) {
    throw new BookingError(
      "needs_non_refundable_ok",
      `This appointment is less than ${settings.cancellationDays} days away, so please confirm you understand the deposit can't be refunded.`,
    );
  }

  const service = await prisma.service.findUniqueOrThrow({ where: { id: input.serviceId } });
  const endsAt = new Date(input.startsAt.getTime() + service.durationMin * MINUTE);
  // The checkout page closes 1 minute before the hold ends, so a payment can't
  // normally arrive for a slot that has already been released. (Stripe needs
  // the page open for at least 30 minutes; the extra minutes cover the time
  // taken to create it.)
  const holdExpiresAt = new Date(now.getTime() + (settings.holdMinutes + 2) * MINUTE);
  const checkoutExpiresAt = new Date(now.getTime() + (settings.holdMinutes + 1) * MINUTE);

  let booking: Booking;
  try {
    booking = await prisma.$transaction(async (tx) => {
      await lockCalendar(tx);
      await expireStaleHolds(now, tx);

      // The phone has been verified by sign-in, so the customer's name and
      // email can be kept up to date from the form.
      const { name, phone, email } = input.customer;
      const customer = await tx.customer.upsert({
        where: { phone },
        update: { name, ...(email ? { email } : {}) },
        create: { name, phone, email: email || null },
      });

      const newDog = "id" in input.dog ? null : input.dog;
      const dog = newDog
        ? // A "new" dog with the same name as a saved one is the same dog.
          ((await tx.dog.findFirst({
            where: { customerId: customer.id, name: { equals: newDog.name, mode: "insensitive" } },
          })) ??
          (await tx.dog.create({
            data: {
              customerId: customer.id,
              name: newDog.name,
              breed: newDog.breed || null,
              size: newDog.size,
              notes: newDog.notes || null,
            },
          })))
        : await tx.dog.findFirst({ where: { id: (input.dog as { id: string }).id, customerId: customer.id } });
      if (!dog) throw new BookingError("dog_not_found", "Please choose one of your dogs or add a new one.");

      return tx.booking.create({
        data: {
          customerId: customer.id,
          dogId: dog.id,
          serviceId: service.id,
          startsAt: input.startsAt,
          endsAt,
          blockedUntil: new Date(endsAt.getTime() + settings.bufferMin * MINUTE),
          status: "pending_payment",
          holdExpiresAt,
          depositCents: settings.depositCents,
          priceCents: service.priceCents,
          source: "online",
        },
      });
    });
  } catch (e) {
    if (isOverlapError(e)) {
      throw new BookingError("slot_taken", "Sorry, someone has just booked that time. Please pick another.");
    }
    throw e;
  }

  try {
    const checkout = await paymentProvider().createDepositCheckout({
      bookingId: booking.id,
      amountCents: booking.depositCents,
      description: `Deposit: ${service.name}, ${formatDateLong(booking.startsAt, tz)}, ${formatTime(booking.startsAt, tz)}`,
      customerEmail: input.customer.email,
      successUrl: `${opts.baseUrl}/book/done?booking=${booking.id}`,
      cancelUrl: `${opts.baseUrl}/book/cancelled?booking=${booking.id}`,
      expiresAt: checkoutExpiresAt,
    });
    await prisma.booking.update({ where: { id: booking.id }, data: { stripeCheckoutId: checkout.id } });
    return { bookingId: booking.id, checkoutUrl: checkout.url };
  } catch (e) {
    // Don't leave the slot blocked if the payment page couldn't be opened.
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "expired" } });
    console.error("Couldn't create deposit checkout", e);
    throw new BookingError("payment_setup_failed", "We couldn't open the payment page. Please try again.");
  }
}

export type DepositPaid = {
  bookingId: string;
  checkoutId: string;
  paymentIntentId: string;
  amountCents: number;
  currency: string;
};

export type ConfirmResult =
  | "confirmed"
  | "already_processed"
  | "refunded_slot_taken"
  | "refunded_cancelled"
  | "refunded_duplicate"
  | "not_found"
  | "checkout_mismatch"
  | "amount_mismatch";

/**
 * Records a paid deposit and confirms the booking. Webhooks can arrive twice,
 * late or at the same time; each payment is only ever counted once.
 * If the slot was lost meanwhile, the deposit is refunded automatically.
 */
export async function confirmDepositPaid(paid: DepositPaid): Promise<ConfirmResult> {
  const booking = await prisma.booking.findUnique({ where: { id: paid.bookingId } });
  if (!booking) return "not_found";
  if (booking.stripeCheckoutId !== paid.checkoutId) return "checkout_mismatch";

  const seen = await prisma.payment.findUnique({ where: { stripeId: paid.paymentIntentId } });
  if (seen) return "already_processed";

  if (paid.amountCents !== booking.depositCents || paid.currency.toLowerCase() !== "usd") {
    console.error("Deposit amount doesn't match booking", { paid, expected: booking.depositCents });
    return "amount_mismatch";
  }

  if (booking.status === "pending_payment" || booking.status === "expired") {
    try {
      await prisma.$transaction(async (tx) => {
        await lockCalendar(tx); // reviving an expired hold re-checks the calendar
        // Recording the payment first means a duplicate webhook fails here
        // (stripe_id is unique) and changes nothing.
        await tx.payment.create({
          data: { bookingId: booking.id, type: "deposit", amountCents: paid.amountCents, stripeId: paid.paymentIntentId, status: "succeeded" },
        });
        // An expired hold can come back to life if nobody took the slot;
        // the no-overlap constraint refuses it if somebody did.
        const { count } = await tx.booking.updateMany({
          where: { id: booking.id, status: { in: ["pending_payment", "expired"] } },
          data: { status: "confirmed", holdExpiresAt: null, stripePaymentIntentId: paid.paymentIntentId },
        });
        // The status changed under us (e.g. cancelled): undo, and refund below.
        if (count !== 1) throw new StatusChanged();
      });
      // TODO(step 6): send the confirmation text.
      return "confirmed";
    } catch (e) {
      if (isUniqueError(e)) return "already_processed";
      if (e instanceof StatusChanged) return refundDeposit(booking.id, paid, "cancelled");
      if (!isOverlapError(e)) throw e;
      // Slot taken by someone else while this payment was in flight.
      return refundDeposit(booking.id, paid, "slot_taken");
    }
  }

  if (booking.status === "confirmed" || booking.status === "completed" || booking.status === "no_show") {
    // Paid twice with two different payments: give the second one back.
    return refundDeposit(booking.id, paid, "duplicate_payment");
  }

  return refundDeposit(booking.id, paid, "cancelled");
}

async function refundDeposit(
  bookingId: string,
  paid: DepositPaid,
  reason: "slot_taken" | "cancelled" | "duplicate_payment",
): Promise<ConfirmResult> {
  try {
    await prisma.payment.create({
      data: { bookingId, type: "deposit", amountCents: paid.amountCents, stripeId: paid.paymentIntentId, status: "succeeded" },
    });
  } catch (e) {
    if (isUniqueError(e)) return "already_processed";
    throw e;
  }
  const refundId = await paymentProvider().refund({
    paymentIntentId: paid.paymentIntentId,
    amountCents: paid.amountCents,
    bookingId,
    reason,
  });
  await prisma.payment.upsert({
    where: { stripeId: refundId },
    update: {},
    create: { bookingId, type: "refund", amountCents: paid.amountCents, stripeId: refundId, status: "succeeded" },
  });
  // TODO(step 6): text the customer that the slot was lost and the deposit refunded.
  console.warn(`Refunded deposit for booking ${bookingId}: ${reason}`);
  if (reason === "slot_taken") return "refunded_slot_taken";
  return reason === "duplicate_payment" ? "refunded_duplicate" : "refunded_cancelled";
}

/** The customer backed out of the payment page: free the slot straight away. */
export async function releaseHold(bookingId: string): Promise<void> {
  const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
  if (!booking || booking.status !== "pending_payment") return;
  if (booking.stripeCheckoutId) {
    // Close the payment page first so it can't take money for a released slot.
    await paymentProvider().expireCheckout(booking.stripeCheckoutId);
  }
  await prisma.booking.updateMany({ where: { id: bookingId, status: "pending_payment" }, data: { status: "expired" } });
}

/** Stripe closed an unpaid checkout page: free the slot. */
export async function handleCheckoutExpired(checkoutId: string): Promise<void> {
  await prisma.booking.updateMany({
    where: { stripeCheckoutId: checkoutId, status: "pending_payment" },
    data: { status: "expired" },
  });
}

/** What the confirmation page needs to show. No personal details. */
export async function getBookingSummary(bookingId: string) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      status: true,
      startsAt: true,
      endsAt: true,
      depositCents: true,
      priceCents: true,
      service: { select: { name: true } },
      dog: { select: { name: true } },
    },
  });
  return booking;
}
