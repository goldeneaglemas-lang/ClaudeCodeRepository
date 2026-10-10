// What a signed-in customer can see and change (PLAN.md §3.2, §5.6).
import type { DogSize } from "@prisma/client";
import { prisma } from "./prisma";
import { paymentProvider } from "./payments";
import { isRefundable } from "./policy";
import { getSettings } from "./slots";

export async function getAccount(phone: string) {
  return prisma.customer.findUnique({
    where: { phone },
    include: { dogs: { orderBy: { createdAt: "asc" } } },
  });
}

const bookingView = {
  id: true,
  status: true,
  startsAt: true,
  endsAt: true,
  depositCents: true,
  priceCents: true,
  cancelledAt: true,
  service: { select: { id: true, name: true } },
  dog: { select: { name: true } },
  payments: { select: { type: true, amountCents: true, status: true } },
} as const;

/** Upcoming (confirmed, still to come) and past bookings. Unpaid holds aren't shown. */
export async function listBookings(phone: string, now = new Date()) {
  const bookings = await prisma.booking.findMany({
    where: { customer: { phone }, status: { in: ["confirmed", "completed", "cancelled", "no_show"] } },
    orderBy: { startsAt: "asc" },
    select: bookingView,
  });
  const upcoming = bookings.filter((b) => b.status === "confirmed" && b.startsAt > now);
  const past = bookings.filter((b) => !upcoming.includes(b)).reverse(); // most recent first
  return { upcoming, past };
}

export class CancelError extends Error {
  constructor(readonly code: "not_found" | "not_cancellable", message: string) {
    super(message);
  }
}

/**
 * The customer cancels their own booking. 10 or more days ahead, the deposit
 * is refunded; otherwise Jess keeps it. The slot is freed either way.
 */
export async function cancelBookingByCustomer(bookingId: string, phone: string, now = new Date()): Promise<{ refunded: boolean }> {
  const booking = await prisma.booking.findFirst({ where: { id: bookingId, customer: { phone } } });
  if (!booking) throw new CancelError("not_found", "Booking not found.");
  if (booking.status !== "confirmed" || booking.startsAt <= now) {
    throw new CancelError("not_cancellable", "This booking can't be cancelled online. Please call Jess.");
  }

  const { cancellationDays } = await getSettings();
  const refundable = isRefundable(booking.startsAt, now, cancellationDays);

  // Cancel first (frees the slot). Only one cancel can win if two arrive at once.
  const { count } = await prisma.booking.updateMany({
    where: { id: booking.id, status: "confirmed" },
    data: { status: "cancelled", cancelledAt: now },
  });
  if (count === 0) throw new CancelError("not_cancellable", "This booking has already been cancelled.");

  if (!refundable || !booking.stripePaymentIntentId) return { refunded: false };

  try {
    const refundId = await paymentProvider().refund({
      paymentIntentId: booking.stripePaymentIntentId,
      amountCents: booking.depositCents,
      bookingId: booking.id,
      reason: "customer_cancelled",
    });
    await prisma.payment.upsert({
      where: { stripeId: refundId },
      update: {},
      create: { bookingId: booking.id, type: "refund", amountCents: booking.depositCents, stripeId: refundId, status: "succeeded" },
    });
    // TODO(step 6): text the customer that the booking is cancelled and the deposit refunded.
    return { refunded: true };
  } catch (e) {
    // The booking stays cancelled; the failed refund is recorded so Jess can
    // see it on her dashboard and retry it (step 5).
    console.error("Refund failed for cancelled booking", booking.id, e);
    await prisma.payment.create({
      data: { bookingId: booking.id, type: "refund", amountCents: booking.depositCents, status: "failed" },
    });
    return { refunded: false };
  }
}

export type DogUpdate = { name: string; breed?: string | null; size: DogSize; notes?: string | null };

export async function updateDog(phone: string, dogId: string, data: DogUpdate): Promise<boolean> {
  const { count } = await prisma.dog.updateMany({
    where: { id: dogId, customer: { phone } },
    data: { name: data.name, breed: data.breed || null, size: data.size, notes: data.notes || null },
  });
  return count === 1;
}

export async function setReminderTexts(phone: string, on: boolean): Promise<boolean> {
  const { count } = await prisma.customer.updateMany({ where: { phone }, data: { smsOptIn: on } });
  return count === 1;
}
