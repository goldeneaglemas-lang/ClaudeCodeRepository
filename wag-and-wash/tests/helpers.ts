import { PrismaClient, Prisma } from "@prisma/client";

// TEST_DATABASE_URL is set by tests/global-setup.ts to this run's own database.
if (!process.env.TEST_DATABASE_URL) throw new Error("Run the tests with `npm test`.");

export const db = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } });

/** Empties the booking-related tables between tests. Seeded services, hours and settings stay. */
export async function clearBookings() {
  await db.$executeRawUnsafe('TRUNCATE "sms_logs", "payments", "bookings", "dogs", "customers", "time_off" CASCADE');
}

let phoneCounter = 0;

/** A customer with one dog. */
export async function makeCustomerWithDog() {
  phoneCounter += 1;
  const customer = await db.customer.create({
    data: {
      name: `Test Customer ${phoneCounter}`,
      phone: `+1555000${String(phoneCounter).padStart(4, "0")}`,
      dogs: { create: { name: "Biscuit", size: "medium" } },
    },
    include: { dogs: true },
  });
  return { customer, dog: customer.dogs[0] };
}

const minutes = (n: number) => n * 60_000;

/** Booking data for a 60-minute appointment with a 15-minute cleanup gap. */
export async function bookingData(
  startsAt: Date,
  overrides: Partial<Prisma.BookingUncheckedCreateInput> = {},
): Promise<Prisma.BookingUncheckedCreateInput> {
  const { customer, dog } = await makeCustomerWithDog();
  const service = await db.service.findFirstOrThrow({ where: { name: "Bath & Brush" } });
  const endsAt = new Date(startsAt.getTime() + minutes(service.durationMin));
  return {
    customerId: customer.id,
    dogId: dog.id,
    serviceId: service.id,
    startsAt,
    endsAt,
    blockedUntil: new Date(endsAt.getTime() + minutes(15)),
    status: "pending_payment",
    holdExpiresAt: new Date(Date.now() + minutes(15)),
    depositCents: 2500,
    priceCents: service.priceCents,
    ...overrides,
  };
}

/** True if the error is Postgres refusing an overlapping booking. */
export function isOverlapError(e: unknown): boolean {
  return String((e as Error)?.message ?? e).includes("bookings_no_overlap");
}

export const at = (iso: string) => new Date(iso);
