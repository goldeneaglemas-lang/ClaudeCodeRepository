# Wag & Wash: Booking App Plan

Wag & Wash is a dog grooming business run by Jess. Customers book an appointment
online and pay a **$25 deposit** to hold it. Jess runs the day from an owner
dashboard. Customers get a text reminder before their appointment.

> Status: **steps 1–3 done** (skeleton, availability, booking + deposit). Next: step 4
> (phone sign-in + My bookings). Jess's answers
> are in §8; a few smaller questions remain, with defaults in use.

---

## 1. Goals and scope

**In scope (v1)**
- A customer picks a service and a free time slot, adds their dog(s), and pays a $25 deposit.
- The booking is confirmed only once the deposit has been paid.
- A customer can see their upcoming and past bookings, and cancel one.
- Jess sees the day/week schedule, the customers and their dogs, and can mark bookings done, no-show or cancelled.
- An SMS reminder is sent before each appointment.

**Out of scope (v1)**
- More than one groomer or location. Jess is the only groomer.
- More than one dog per booking. A customer with two dogs makes two bookings.
- Prices or lengths that change with dog size.
- Taking the full balance online. Jess collects the rest in person.
- Loyalty points, packages, gift cards, a native mobile app.

---

## 2. Tech stack (recommended)

| Concern | Choice | Why |
|---|---|---|
| App + API | **Next.js** (App Router, TypeScript) | One codebase for the 3 screens and the back end. Easy to deploy. |
| Database | **PostgreSQL** + **Prisma** ORM | Relational data. Postgres can block double-bookings in the database itself (§5). |
| Payments | **Stripe** (Checkout + webhooks) | Hosted card page, so no card data touches our server. Refunds are built in. |
| SMS | **Twilio** | Reminders and confirmations. Handles STOP/opt-out. |
| Auth | Customer: SMS one-time code to their phone. Jess: email + password with 2FA. | Customers don't need a password, and their phone number is already their ID for reminders. |
| Scheduled jobs | Vercel Cron (or a worker) every 5 min | Sends due reminders and clears expired holds. |
| Hosting | Vercel + managed Postgres (Neon or Supabase) | Low running cost for a small business. |

---

## 3. Screens

### 3.1 Booking page (`/book`), for customers
1. **Pick a service**: Bath, Full Groom, Nail Trim, etc. Each shows its price and length. Price and length are the same for every dog size.
2. **Pick a date and time**: a calendar showing only free slots (from `GET /api/slots`).
3. **Your details**: phone number (checked with a code), name, email (optional).
4. **Your dog(s)**: choose a saved dog or add one (name, breed, size, notes such as "nervous of dryers").
5. **Review and pay the deposit**: summary (price, $25 deposit, balance due on the day = price − $25), the
   10-day cancellation policy and a $25 deposit button. This goes to Stripe Checkout.
   If the appointment is **less than 10 days away**, a clear notice says the deposit is non-refundable from the start,
   and the customer must tick a box to accept that.
6. **Confirmation page**: "You're booked!" plus an SMS confirmation.

If a slot is taken while the customer is paying, they see a clear message and are sent back to step 2 (see §5).

### 3.2 My bookings (`/my-bookings`), for signed-in customers
- Upcoming bookings: date, time, service, dog, deposit paid, balance due.
- **Cancel** button. If the appointment is 10 or more days away, the deposit is refunded. If it's closer, the button warns that the deposit will be kept.
- Each booking shows the last date it can be cancelled for a refund.
- Past bookings, and a **Book again** shortcut.
- Manage dogs (edit or add) and SMS reminder preferences.

### 3.3 Owner dashboard (`/admin`), for Jess only
- **Today**: a timeline of appointments with the dog's name, size and notes, the customer's phone, and the deposit status.
  Buttons: *Checked in*, *Completed*, *No-show*, *Cancel (refund or keep deposit)*.
- **Calendar**: a week view. Jess can block time off (lunch, holidays) and add a walk-in or phone booking without taking a deposit.
- **Customers and dogs**: search, history, notes.
- **Settings**: opening hours, services (name, length, price), deposit amount, reminder timing, cancellation window.
- **Money**: deposits taken, refunds and no-shows for a chosen date range.

---

## 4. Data model

Core tables: **Customer, Dog, Booking**. A few supporting tables make the
core ones work.

```
Customer
  id            uuid PK
  name          text
  phone         text UNIQUE      -- E.164, e.g. +15551234567; used for login + SMS
  email         text NULL
  sms_opt_in    boolean default true
  created_at    timestamptz

Dog
  id            uuid PK
  customer_id   uuid FK -> Customer
  name          text
  breed         text NULL
  size          enum(small, medium, large, xl)
  notes         text NULL        -- temperament, allergies, vet info
  created_at    timestamptz

Booking
  id                 uuid PK
  customer_id        uuid FK -> Customer
  dog_id             uuid FK -> Dog
  service_id         uuid FK -> Service
  starts_at          timestamptz
  ends_at            timestamptz
  status             enum(pending_payment, confirmed, completed,
                          cancelled, no_show, expired)
  hold_expires_at    timestamptz NULL  -- for pending_payment only
  deposit_cents      int  default 2500
  price_cents        int               -- service price, copied in at booking time
                                       -- balance due on the day = price_cents - deposit_cents
  stripe_checkout_id text NULL
  stripe_payment_intent_id text NULL
  reminder_sent_at   timestamptz NULL
  source             enum(online, owner)  -- owner = walk-in or phone booking
  created_at, updated_at

  blocked_until      timestamptz       -- ends_at + Jess's cleanup gap

  -- Blocks double-booking (and protects the cleanup gap) at the database level:
  EXCLUDE USING gist (tstzrange(starts_at, blocked_until) WITH &&)
    WHERE (status IN ('pending_payment','confirmed'))
```

**Supporting tables**
- `Service`: name, duration_min, price_cents, active
- `BusinessHours`: weekday, open_time, close_time
- `TimeOff`: starts_at, ends_at, reason (blocks slots)
- `Settings`: one row of shop-wide rules (timezone, $25 deposit, 10-day cancellation, 15-min gap, 30-min hold, reminder timing, 2h minimum notice, 60-day booking window)
- `Owner`: email, password_hash, 2FA secret
- `Payment`: booking_id, type (deposit/refund), amount_cents, stripe_id, status. This is an audit trail.
- `SmsLog`: booking_id, kind (confirmation/reminder), twilio_sid, status

Because Jess is the only groomer, there is one calendar, and the exclusion
constraint covers every booking. *If she ever hires a second groomer:* add a
`Groomer` table, put `groomer_id` on Booking, and add `groomer_id WITH =` to the
constraint. Each booking has exactly one dog, so `dog_id` is a single column.

---

## 5. Back-end flow

### 5.1 Finding free slots: `GET /api/slots?serviceId=…&from=YYYY-MM-DD&to=YYYY-MM-DD`
Free slots = business hours − time off − existing `confirmed` bookings −
unexpired `pending_payment` holds. Slots are generated on a 15-minute grid from
opening time and sized to the service's length. The calendar asks for a month
at a time (up to 62 days per request).

Rules, as built:
- The appointment must **finish by closing time**; the cleanup gap may run past it.
- The new appointment **plus its 15-minute gap** must not overlap another booking plus its gap (the same rule as the database constraint).
- Time off only has to avoid the appointment itself, so Jess can clean up during a break.
- At least **2 hours' notice** (`min_notice_hours`), and no more than **60 days ahead** (`booking_window_days`). Both are settings Jess can change.
- Dates and times use the **shop's timezone**, wherever the server or customer is, including on daylight-saving days.
- A hold whose 15 minutes have run out shows as free straight away. Step 3 must mark such holds expired before inserting, because the database still counts them until the clean-up job runs.

### 5.2 Booking and paying the deposit: `POST /api/bookings`
1. **Validate** the input: the service exists, the slot is in the future and within hours, and the dog belongs to the customer.
2. **Hold the slot**: insert the Booking with `status = pending_payment` and `hold_expires_at = now + 32 min`.
   (Stripe's checkout page must stay open for at least 30 minutes, so the hold is 30 minutes plus a 2-minute
   margin, and the checkout page closes 1 minute before the hold ends.) Stale holds are cleared first, in the
   same transaction.
   The exclusion constraint makes this **atomic**. If two people click the same slot at once, one insert fails, and that person gets `409 Slot taken`.
3. **Create a Stripe Checkout session** for $25 with `metadata.booking_id`, then return its URL.
4. The customer pays on Stripe's hosted page.

### 5.3 Confirming: `POST /api/webhooks/stripe`
- Verify the Stripe signature.
- On `checkout.session.completed`: set the booking to `confirmed`, record the Payment, and send the confirmation SMS.
- The handler is **idempotent**, so a repeated webhook does nothing, even when copies arrive at the same moment (the payment's Stripe id is unique).
- The amount and currency must match the booking's deposit, or the booking isn't confirmed.
- Payment after the hold expired: confirm if the slot is still free; if someone else has taken it, refund automatically (text the customer: step 6).
- Payment for a cancelled booking, or a second payment for a confirmed one: refund automatically.
- `checkout.session.expired`: free the slot.
- If the customer backs out of the payment page, the slot is freed at once and the checkout page is closed.
- Without `STRIPE_SECRET_KEY`, a built-in **test checkout page** (`/dev/checkout/…`) stands in for Stripe and calls the same code. It is switched off in production.

### 5.4 Clearing holds (cron, every 5 min)
- Set `pending_payment` bookings older than `hold_expires_at` to `expired`. This frees the slot.
- `GET /api/cron/expire-holds` with `Authorization: Bearer $CRON_SECRET`. Scheduled in `vercel.json`. (Vercel's free plan only runs crons daily; that's fine, because booking clears stale holds itself.)

### 5.5 SMS reminder (cron, every 5 min)
- Find `confirmed` bookings where `starts_at` is within 24h (configurable), `reminder_sent_at IS NULL` and the customer is opted in.
- Send via Twilio: *"Hi Sam! Reminder: Biscuit's Full Groom at Wag & Wash tomorrow 10:30am. Reply C to cancel."*
- Set `reminder_sent_at` in the same transaction as claiming the row, so a reminder is never sent twice.
- Inbound Twilio webhook: `STOP` opts the customer out. `C` could start a cancellation (v1.1).

### 5.6 Cancelling: `POST /api/bookings/:id/cancel`
- Customer: if `starts_at − now ≥ 10 days`, refund the $25 deposit through Stripe. Otherwise the deposit is kept. The check runs on the server, at the moment of cancelling.
- Jess: chooses *refund* or *keep* each time.

### 5.7 API summary
| Method | Path | Who |
|---|---|---|
| POST | `/api/auth/otp/send`, `/api/auth/otp/verify` | customer |
| GET | `/api/services`, `/api/slots?serviceId&from&to` | public |
| GET/POST/PATCH | `/api/dogs` | customer |
| POST | `/api/bookings` | customer (public until step 4 adds phone sign-in) |
| GET | `/api/bookings/:id` (status only) | customer |
| POST | `/api/bookings/:id/release` | customer |
| GET | `/api/bookings/mine` | customer |
| POST | `/api/bookings/:id/cancel` | customer / owner |
| GET/PATCH | `/api/admin/bookings`, `/api/admin/customers`, `/api/admin/settings`, `/api/admin/time-off` | owner |
| POST | `/api/webhooks/stripe`, `/api/webhooks/twilio` | Stripe / Twilio |
| — | cron: `expire-holds`, `send-reminders` | system |

---

## 6. Security and reliability
- No card data is stored. Stripe handles all of it.
- Webhook signatures are verified for both Stripe and Twilio.
- The `/admin` routes are owner-only, protected by a server-side role check and 2FA.
- OTP endpoints are rate-limited, so the SMS budget can't be drained.
- Customers can only see or change their own dogs and bookings.
- All times are stored in UTC and shown in the shop's timezone.
- Secrets (Stripe, Twilio, DB) are kept in environment variables and never committed.

---

## 7. Build order (milestones)
1. ✅ **Skeleton**: Next.js app, Prisma schema, migrations, seed services and hours.
2. ✅ **Availability**: the slots endpoint and the booking calendar UI, with tests for overlaps, time off and edges of opening hours.
3. ✅ **Booking + deposit**: hold the slot, Stripe Checkout, webhook confirmation, the expire-holds cron.
4. **Customer auth + My bookings**: OTP login, list, cancel with refund.
5. **Owner dashboard**: today view, calendar, time off, settings, walk-ins.
6. **SMS**: confirmation, reminder cron, STOP handling.
7. **Polish and launch**: mobile layout, error states, Stripe/Twilio live keys, a test day with Jess.

**Testing:** unit tests for slot maths and the 10-day refund rule (including exactly 10 days, and timezone/daylight-saving edges). Integration tests that
fire two concurrent bookings at the same slot (exactly one may succeed). Stripe CLI
for webhook tests. Twilio test credentials.

---

## 8. Decisions and remaining questions

**Decided by Jess**
| Question | Decision | Effect on the plan |
|---|---|---|
| Cancellation | **10 days' notice** gets the deposit back | Refund rule in §5.6. Warning at checkout for bookings less than 10 days away. |
| Deposit | **Taken off the final price** | Balance due on the day = price − $25, shown everywhere. |
| Prices and lengths | **Same for every dog size** | No size pricing. Dog size is kept only as a note for Jess. |
| Dogs per booking | **One dog** | One `dog_id` per booking. Two dogs = two bookings. |
| Groomers | **Only Jess** | One calendar. No groomer table in v1. |

**Still open (sensible defaults in brackets, used if there's no answer)**
1. **No-shows**: is the deposit kept? *(Yes.)*
2. **Late cancellation by Jess** (she's ill, etc.): always refunded? *(Yes, always.)*
3. **Services**: the full list with prices and lengths. *(Placeholder services seeded until she sends them.)*
4. **Opening hours, timezone**, and cleanup time between appointments. *(Tue–Sat 9am–5pm, 15-minute gap.)*
5. **Reminders**: 24h before? Given the 10-day rule, also a text **11 days before** saying "last day to cancel for a refund is tomorrow"? *(Both.)*
6. Existing **Stripe / Twilio** accounts and a phone number to text from. *(We set up new ones.)*
7. Domain name and branding. *(Simple placeholder branding.)*
