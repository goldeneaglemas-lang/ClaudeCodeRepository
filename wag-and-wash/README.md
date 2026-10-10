# Wag & Wash

Online booking for Wag & Wash, Jess's dog grooming business. Customers book and
pay a $25 deposit; Jess runs the day from an owner dashboard. The full design
is in [PLAN.md](PLAN.md).

**Status:** steps 1–4 of 7 are done. Customers confirm their phone with a
texted code, book a time and pay the $25 deposit, then see and cancel their
bookings on "My bookings" (refunded 10+ days ahead). Next: Jess's dashboard.

## Run it locally

Needs Node 22 and PostgreSQL 16.

```bash
cp .env.example .env        # then edit the database URLs if needed
npm install
npm run db:migrate          # create the tables
npm run db:seed             # placeholder services, hours and settings
npm run dev                 # http://localhost:3000
```

## Payments without a Stripe account

If `STRIPE_SECRET_KEY` is empty, `npm run dev` uses a built-in **test checkout
page** with "Pay" and "Cancel" buttons; no money moves. It runs the same
confirm/refund code as Stripe. It's switched off in production (`npm start`),
which refuses to take bookings without a Stripe key.

To use real Stripe (test mode):
1. Create a free account at stripe.com and copy the test secret key into `STRIPE_SECRET_KEY`.
2. Install the Stripe CLI and run `stripe listen --forward-to localhost:3000/api/webhooks/stripe`.
3. Copy the `whsec_…` secret it prints into `STRIPE_WEBHOOK_SECRET`, restart `npm run dev`.
4. Pay with card `4242 4242 4242 4242`, any future date, any CVC.

## Texts without a Twilio account

If `TWILIO_*` is empty, `npm run dev` doesn't send texts. Sign-in codes are
shown on screen in a yellow "Test mode" box, and texts are written to the
server log. Production refuses to run without Twilio settings.

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
| `src/app/book/` | Booking page: service → calendar → time → summary |
| `src/app/api/` | Services, slots, bookings, Stripe webhook, hold clean-up job |
| `src/lib/availability.ts` | The slot rules (hours, bookings + cleanup gap, time off, notice, window) |
| `src/lib/time.ts` | Shop-timezone date helpers, daylight-saving safe |
| `src/lib/policy.ts` | The 10-day refund rule |
| `src/lib/bookings.ts` | Hold a slot, confirm a paid deposit, refund when needed, release holds |
| `src/lib/payments/` | Stripe, plus the test stand-in used when there's no Stripe key |
| `src/app/api/webhooks/stripe/` | Stripe tells us here when a deposit is paid |
| `src/app/my-bookings/` | My bookings: upcoming, cancel, past, dogs, reminder setting |
| `src/lib/auth.ts` | Sign-in codes, sessions, rate limits |
| `src/lib/account.ts` | What a signed-in customer can see and change, including cancelling |
| `src/lib/sms/` | Twilio, plus the test stand-in used when there are no Twilio settings |
| `src/lib/` (other) | Database client, money helpers, slot loading |
| `tests/` | Tests, including 10 customers booking the same slot at once |

## How double-booking is prevented

Postgres itself refuses any booking whose time (plus Jess's 15-minute cleanup
gap) overlaps another unpaid-hold or confirmed booking. The check is atomic, so
two customers clicking the same slot at the same moment can't both get it.
Cancelled, expired, completed and no-show bookings free their slot.
