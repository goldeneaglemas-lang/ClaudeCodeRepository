# Wag & Wash

Online booking for Wag & Wash, Jess's dog grooming business. Customers book and
pay a $25 deposit; Jess runs the day from an owner dashboard. The full design
is in [PLAN.md](PLAN.md).

**Status:** step 1 of 7 (skeleton) is done: app, database, placeholder data.

## Run it locally

Needs Node 22 and PostgreSQL 16.

```bash
cp .env.example .env        # then edit the database URLs if needed
npm install
npm run db:migrate          # create the tables
npm run db:seed             # placeholder services, hours and settings
npm run dev                 # http://localhost:3000
```

## Checks

```bash
npm test                    # creates a throwaway database, runs the tests, drops it
npm run typecheck
npm run build
```

## Layout

| Path | What it is |
|---|---|
| `prisma/schema.prisma` | Tables: customers, dogs, bookings, services, hours, time off, settings, owners, payments, SMS log |
| `prisma/migrations/` | SQL migrations, including the hand-written **no double-booking** rule |
| `prisma/seed.ts` | Placeholder services and hours (Tue–Sat 9–5) until Jess sends the real ones |
| `src/app/` | Next.js pages |
| `src/lib/` | Shared code (database client, money helpers) |
| `tests/` | Tests, including 10 customers booking the same slot at once |

## How double-booking is prevented

Postgres itself refuses any booking whose time (plus Jess's 15-minute cleanup
gap) overlaps another unpaid-hold or confirmed booking. The check is atomic, so
two customers clicking the same slot at the same moment can't both get it.
Cancelled, expired, completed and no-show bookings free their slot.
