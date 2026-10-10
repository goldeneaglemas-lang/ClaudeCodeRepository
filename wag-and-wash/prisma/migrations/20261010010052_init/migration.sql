-- CreateEnum
CREATE TYPE "DogSize" AS ENUM ('small', 'medium', 'large', 'xl');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('pending_payment', 'confirmed', 'completed', 'cancelled', 'no_show', 'expired');

-- CreateEnum
CREATE TYPE "BookingSource" AS ENUM ('online', 'owner');

-- CreateEnum
CREATE TYPE "PaymentType" AS ENUM ('deposit', 'refund');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('pending', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "SmsKind" AS ENUM ('confirmation', 'reminder', 'refund_deadline', 'cancellation');

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "sms_opt_in" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dogs" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "breed" TEXT,
    "size" "DogSize" NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "dogs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "services" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "duration_min" INTEGER NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "dog_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ NOT NULL,
    "ends_at" TIMESTAMPTZ NOT NULL,
    "blocked_until" TIMESTAMPTZ NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'pending_payment',
    "hold_expires_at" TIMESTAMPTZ,
    "deposit_cents" INTEGER NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "stripe_checkout_id" TEXT,
    "stripe_payment_intent_id" TEXT,
    "reminder_sent_at" TIMESTAMPTZ,
    "refund_deadline_sent_at" TIMESTAMPTZ,
    "cancelled_at" TIMESTAMPTZ,
    "source" "BookingSource" NOT NULL DEFAULT 'online',
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_hours" (
    "id" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "open_time" TEXT NOT NULL,
    "close_time" TEXT NOT NULL,

    CONSTRAINT "business_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "time_off" (
    "id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ NOT NULL,
    "ends_at" TIMESTAMPTZ NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "time_off_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "deposit_cents" INTEGER NOT NULL DEFAULT 2500,
    "cancellation_days" INTEGER NOT NULL DEFAULT 10,
    "buffer_min" INTEGER NOT NULL DEFAULT 15,
    "slot_step_min" INTEGER NOT NULL DEFAULT 15,
    "hold_minutes" INTEGER NOT NULL DEFAULT 15,
    "reminder_hours_before" INTEGER NOT NULL DEFAULT 24,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "owners" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "totp_secret" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "owners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "type" "PaymentType" NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "stripe_id" TEXT,
    "status" "PaymentStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_logs" (
    "id" UUID NOT NULL,
    "booking_id" UUID,
    "to_phone" TEXT NOT NULL,
    "kind" "SmsKind" NOT NULL,
    "body" TEXT NOT NULL,
    "twilio_sid" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sms_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customers_phone_key" ON "customers"("phone");

-- CreateIndex
CREATE INDEX "dogs_customer_id_idx" ON "dogs"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "services_name_key" ON "services"("name");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_stripe_checkout_id_key" ON "bookings"("stripe_checkout_id");

-- CreateIndex
CREATE INDEX "bookings_starts_at_idx" ON "bookings"("starts_at");

-- CreateIndex
CREATE INDEX "bookings_customer_id_idx" ON "bookings"("customer_id");

-- CreateIndex
CREATE INDEX "bookings_status_idx" ON "bookings"("status");

-- CreateIndex
CREATE UNIQUE INDEX "business_hours_weekday_key" ON "business_hours"("weekday");

-- CreateIndex
CREATE INDEX "time_off_starts_at_idx" ON "time_off"("starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "owners_email_key" ON "owners"("email");

-- CreateIndex
CREATE UNIQUE INDEX "payments_stripe_id_key" ON "payments"("stripe_id");

-- CreateIndex
CREATE INDEX "payments_booking_id_idx" ON "payments"("booking_id");

-- CreateIndex
CREATE UNIQUE INDEX "sms_logs_twilio_sid_key" ON "sms_logs"("twilio_sid");

-- CreateIndex
CREATE INDEX "sms_logs_booking_id_idx" ON "sms_logs"("booking_id");

-- AddForeignKey
ALTER TABLE "dogs" ADD CONSTRAINT "dogs_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_dog_id_fkey" FOREIGN KEY ("dog_id") REFERENCES "dogs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sms_logs" ADD CONSTRAINT "sms_logs_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written rules (Prisma can't express these). See PLAN.md §4 and §5.2.
-- ---------------------------------------------------------------------------

-- No two live bookings may overlap, including Jess's cleanup gap after each
-- one ("blocked_until" = "ends_at" + gap). Jess is the only groomer, so this
-- covers the whole calendar. An insert that collides fails atomically, which
-- is what stops two customers grabbing the same slot at the same moment.
-- Expired, cancelled, completed and no-show bookings don't block the slot.
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_no_overlap"
  EXCLUDE USING gist (tstzrange("starts_at", "blocked_until", '[)') WITH &&)
  WHERE ("status" IN ('pending_payment', 'confirmed'));

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_times_valid"
    CHECK ("ends_at" > "starts_at" AND "blocked_until" >= "ends_at"),
  ADD CONSTRAINT "bookings_amounts_valid"
    CHECK ("deposit_cents" >= 0 AND "price_cents" >= "deposit_cents"),
  ADD CONSTRAINT "bookings_hold_only_when_pending"
    CHECK ("status" <> 'pending_payment' OR "hold_expires_at" IS NOT NULL);

ALTER TABLE "time_off"
  ADD CONSTRAINT "time_off_ends_after_starts" CHECK ("ends_at" > "starts_at");

ALTER TABLE "services"
  ADD CONSTRAINT "services_values_valid" CHECK ("duration_min" > 0 AND "price_cents" >= 0);

ALTER TABLE "business_hours"
  ADD CONSTRAINT "business_hours_weekday_valid" CHECK ("weekday" BETWEEN 0 AND 6),
  ADD CONSTRAINT "business_hours_times_valid" CHECK (
    "open_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    AND "close_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    AND "open_time" < "close_time"
  );

ALTER TABLE "settings"
  ADD CONSTRAINT "settings_single_row" CHECK ("id" = 1),
  ADD CONSTRAINT "settings_values_valid" CHECK (
    "deposit_cents" >= 0 AND "cancellation_days" >= 0 AND "buffer_min" >= 0
    AND "slot_step_min" > 0 AND "hold_minutes" > 0 AND "reminder_hours_before" > 0
  );
