-- AlterTable
ALTER TABLE "settings" ADD COLUMN     "booking_window_days" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN     "min_notice_hours" INTEGER NOT NULL DEFAULT 2;

ALTER TABLE "settings"
  ADD CONSTRAINT "settings_window_valid" CHECK ("min_notice_hours" >= 0 AND "booking_window_days" > 0);
