import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/money";

// Read services and settings on each request, so Jess's changes show at once.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [services, settings] = await Promise.all([
    prisma.service.findMany({ where: { active: true }, orderBy: { sortOrder: "asc" } }),
    prisma.settings.findUnique({ where: { id: 1 } }),
  ]);
  const deposit = settings?.depositCents ?? 2500;
  const cancellationDays = settings?.cancellationDays ?? 10;

  return (
    <main>
      <h1>Wag &amp; Wash</h1>
      <p className="muted">Dog grooming by Jess. One dog per appointment.</p>

      <ul className="services">
        {services.map((s) => (
          <li key={s.id} className="service">
            <div>
              <h2>{s.name}</h2>
              {s.description && <p className="muted">{s.description}</p>}
            </div>
            <div className="price">
              {formatCents(s.priceCents)}
              <div className="muted">{s.durationMin} min</div>
            </div>
          </li>
        ))}
      </ul>

      <p>
        A {formatCents(deposit)} deposit holds your appointment and comes off the final price. Cancel{" "}
        {cancellationDays} or more days ahead for a full refund of the deposit.
      </p>

      <Link className="button" href="/book">
        Book an appointment
      </Link>
    </main>
  );
}
