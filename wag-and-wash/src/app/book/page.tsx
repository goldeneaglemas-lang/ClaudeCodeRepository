import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { currentCustomer } from "@/lib/session";
import { getSettings } from "@/lib/slots";
import { addDays, localDate } from "@/lib/time";
import BookingFlow from "./BookingFlow";

export const metadata: Metadata = { title: "Book an appointment · Wag & Wash" };
export const dynamic = "force-dynamic";

export default async function BookPage({ searchParams }: { searchParams: Promise<{ service?: string }> }) {
  const { service: initialServiceId } = await searchParams;
  const [services, settings, me] = await Promise.all([
    prisma.service.findMany({
      where: { active: true },
      orderBy: { sortOrder: "asc" },
      select: { id: true, name: true, description: true, durationMin: true, priceCents: true },
    }),
    getSettings(),
    currentCustomer(),
  ]);
  // "Today" on the shop's calendar, not the visitor's, so the calendar matches Jess's.
  const today = localDate(new Date(), settings.timezone);

  return (
    <main>
      <h1>Book an appointment</h1>
      <p className="muted">One dog per appointment. Times are shown in the shop&apos;s local time.</p>
      <BookingFlow
        services={services}
        timezone={settings.timezone}
        today={today}
        lastDate={addDays(today, settings.bookingWindowDays)}
        depositCents={settings.depositCents}
        cancellationDays={settings.cancellationDays}
        me={me}
        initialServiceId={initialServiceId ?? null}
      />
    </main>
  );
}
