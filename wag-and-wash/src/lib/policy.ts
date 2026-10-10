// Jess's cancellation rule (PLAN.md §8): cancel 10 or more days before the
// appointment and the deposit is refunded; any later and she keeps it.
import { DAY } from "./time";

/** The last moment a customer can cancel and still get the deposit back. */
export function refundDeadline(startsAt: Date, cancellationDays: number): Date {
  return new Date(startsAt.getTime() - cancellationDays * DAY);
}

/** True if cancelling at `now` gets the deposit back. Exactly 10 days ahead still counts. */
export function isRefundable(startsAt: Date, now: Date, cancellationDays: number): boolean {
  return now.getTime() <= refundDeadline(startsAt, cancellationDays).getTime();
}
