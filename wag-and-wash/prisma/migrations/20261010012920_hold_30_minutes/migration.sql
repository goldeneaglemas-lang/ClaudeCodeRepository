-- AlterTable
ALTER TABLE "settings" ALTER COLUMN "hold_minutes" SET DEFAULT 30;

-- Stripe Checkout sessions must stay open for at least 30 minutes, so a
-- 15-minute hold could run out while the customer is still paying.
UPDATE "settings" SET "hold_minutes" = 30 WHERE "hold_minutes" < 30;
ALTER TABLE "settings" ADD CONSTRAINT "settings_hold_at_least_30" CHECK ("hold_minutes" >= 30);
