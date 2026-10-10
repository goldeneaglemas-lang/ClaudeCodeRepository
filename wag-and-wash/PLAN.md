# Wag & Wash: Booking App Plan

Wag & Wash is a dog grooming business run by Jess. Customers book an appointment
online and pay a **$25 deposit** to hold it. Jess runs the day from an owner
dashboard. Customers get a text reminder before their appointment.

> Status: plan only. No code yet. The open questions at the bottom need answers
> before building.

---

## 1. Goals and scope

**In scope (v1)**
- A customer picks a service and a free time slot, adds their dog(s), and pays a $25 deposit.
- The booking is confirmed only once the deposit has been paid.
- A customer can see their upcoming and past bookings, and cancel one.
- Jess sees the day/week schedule, the customers and their dogs, and can mark bookings done, no-show or cancelled.
- An SMS reminder is sent before each appointment.

**Out of scope (v1)**
- More than one groomer or location (the design leaves room for this; see §4).
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
1. **Pick a service**: Bath, Full Groom, Nail Trim, etc. Each shows its price, length and dog-size options.
2. **Pick a date and time**: a calendar showing only free slots (from `GET /api/slots`).
3. **Your details**: phone number (checked with a code), name, email (optional).
4. **Your dog(s)**: choose a saved dog or add one (name, breed, size, notes such as "nervous of dryers").
5. **Review and pay the deposit**: summary, cancellation policy and a $25 deposit button. This goes to Stripe Checkout.
6. **Confirmation page**: "You're booked!" plus an SMS confirmation.

If a slot is taken while the customer is paying, they see a clear message and are sent back to step 2 (see §5).

### 3.2 My bookings (`/my-bookings`), for signed-in customers
- Upcoming bookings: date, time, service, dog, deposit paid, balance due.
- **Cancel** button. The refund follows the policy (open question 1).
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
  stripe_checkout_id text NULL
  stripe_payment_intent_id text NULL
  reminder_sent_at   timestamptz NULL
  source             enum(online, owner)  -- owner = walk-in or phone booking
  created_at, updated_at

  -- Blocks double-booking at the database level (Postgres btree_gist):
  EXCLUDE USING gist (tstzrange(starts_at, ends_at) WITH &&)
    WHERE (status IN ('pending_payment','confirmed'))
```

**Supporting tables**
- `Service`: name, duration_min, price_cents, active
- `BusinessHours`: weekday, open_time, close_time
- `TimeOff`: starts_at, ends_at, reason (blocks slots)
- `Owner`: email, password_hash, 2FA secret
- `Payment`: booking_id, type (deposit/refund), amount_cents, stripe_id, status. This is an audit trail.
- `SmsLog`: booking_id, kind (confirmation/reminder), twilio_sid, status

*If Jess ever hires a second groomer:* add a `Groomer` table, put `groomer_id` on
Booking, and add `groomer_id WITH =` to the exclusion constraint.

---

## 5. Back-end flow

### 5.1 Finding free slots: `GET /api/slots?service=…&date=…`
Free slots = business hours − time off − existing `confirmed` bookings −
unexpired `pending_payment` holds. Slots are generated on a 15-minute grid and
sized to the service's length.

### 5.2 Booking and paying the deposit: `POST /api/bookings`
1. **Validate** the input: the service exists, the slot is in the future and within hours, and the dog belongs to the customer.
2. **Hold the slot**: insert the Booking with `status = pending_payment` and `hold_expires_at = now + 15 min`.
   The exclusion constraint makes this **atomic**. If two people click the same slot at once, one insert fails, and that person gets `409 Slot taken`.
3. **Create a Stripe Checkout session** for $25 with `metadata.booking_id`, then return its URL.
4. The customer pays on Stripe's hosted page.

### 5.3 Confirming: `POST /api/webhooks/stripe`
- Verify the Stripe signature.
- On `checkout.session.completed`: set the booking to `confirmed`, record the Payment, and send the confirmation SMS.
- The handler is **idempotent**, so a repeated webhook does nothing.
- Edge case: the payment arrives after the hold expired and someone else has taken the slot. Refund the deposit automatically and text the customer.

### 5.4 Clearing holds (cron, every 5 min)
- Set `pending_payment` bookings older than `hold_expires_at` to `expired`. This frees the slot.

### 5.5 SMS reminder (cron, every 5 min)
- Find `confirmed` bookings where `starts_at` is within 24h (configurable), `reminder_sent_at IS NULL` and the customer is opted in.
- Send via Twilio: *"Hi Sam! Reminder: Biscuit's Full Groom at Wag & Wash tomorrow 10:30am. Reply C to cancel."*
- Set `reminder_sent_at` in the same transaction as claiming the row, so a reminder is never sent twice.
- Inbound Twilio webhook: `STOP` opts the customer out. `C` could start a cancellation (v1.1).

### 5.6 Cancelling: `POST /api/bookings/:id/cancel`
- Customer: refund the deposit through Stripe if they cancel outside the cancellation window; otherwise keep it (per policy).
- Jess: chooses *refund* or *keep* each time.

### 5.7 API summary
| Method | Path | Who |
|---|---|---|
| POST | `/api/auth/otp/send`, `/api/auth/otp/verify` | customer |
| GET | `/api/services`, `/api/slots` | public |
| GET/POST/PATCH | `/api/dogs` | customer |
| POST | `/api/bookings` | customer |
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
1. **Skeleton**: Next.js app, Prisma schema, migrations, seed services and hours.
2. **Availability**: the slots endpoint and the booking calendar UI, with tests for overlaps, time off and edges of opening hours.
3. **Booking + deposit**: hold the slot, Stripe Checkout, webhook confirmation, the expire-holds cron.
4. **Customer auth + My bookings**: OTP login, list, cancel with refund.
5. **Owner dashboard**: today view, calendar, time off, settings, walk-ins.
6. **SMS**: confirmation, reminder cron, STOP handling.
7. **Polish and launch**: mobile layout, error states, Stripe/Twilio live keys, a test day with Jess.

**Testing:** unit tests for slot maths and the refund policy. Integration tests that
fire two concurrent bookings at the same slot (exactly one may succeed). Stripe CLI
for webhook tests. Twilio test credentials.

---

## 8. Open questions for Jess
1. **Cancellation policy**: how many hours' notice gets the deposit back? 24h? 48h?
2. **No-shows**: is the deposit simply kept?
3. **Is the deposit taken off the final price**, or is it an extra fee?
4. **Services and lengths**: the full list, and does length or price depend on dog size?
5. **One dog per booking**, or several dogs in one appointment?
6. **Opening hours, timezone**, and the gap needed between appointments (cleanup time)?
7. **Reminder timing**: 24h before? A second one 2h before?
8. **Just Jess**, or other groomers soon?
9. Does she already have **Stripe / Twilio** accounts and a business phone number to text from?
10. Domain name and branding (logo, colours)?
