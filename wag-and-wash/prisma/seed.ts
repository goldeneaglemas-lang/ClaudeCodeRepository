// Seeds the shop's settings, opening hours and services.
// Safe to run more than once: rows are upserted, never duplicated.
// Hours and services are PLACEHOLDERS until Jess sends the real ones (PLAN.md §8).
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Tue–Sat 9am–5pm. 0 = Sunday ... 6 = Saturday.
const HOURS = [2, 3, 4, 5, 6].map((weekday) => ({ weekday, openTime: "09:00", closeTime: "17:00" }));

const SERVICES = [
  { name: "Bath & Brush", description: "Shampoo, blow-dry, brush-out, nails and ears.", durationMin: 60, priceCents: 5500 },
  { name: "Full Groom", description: "Bath & Brush plus a full haircut and styling.", durationMin: 120, priceCents: 8500 },
  { name: "Puppy Intro", description: "A gentle first groom for puppies under 6 months.", durationMin: 45, priceCents: 4500 },
  { name: "Nail Trim & Ear Clean", description: "Quick tidy-up between grooms.", durationMin: 30, priceCents: 3000 },
];

async function main() {
  await prisma.settings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });

  for (const h of HOURS) {
    await prisma.businessHours.upsert({ where: { weekday: h.weekday }, update: {}, create: h });
  }

  for (const [i, s] of SERVICES.entries()) {
    await prisma.service.upsert({ where: { name: s.name }, update: {}, create: { ...s, sortOrder: i } });
  }

  console.log(`Seeded settings, ${HOURS.length} open days and ${SERVICES.length} services.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
