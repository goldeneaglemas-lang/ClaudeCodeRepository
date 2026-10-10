"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { balanceDueCents, formatCents } from "@/lib/money";
import { isRefundable, refundDeadline } from "@/lib/policy";
import { addDays, formatDateLong, formatTime, weekdayOf } from "@/lib/time";
import type { Me } from "@/lib/session";
import DetailsForm from "./DetailsForm";

type Service = { id: string; name: string; description: string | null; durationMin: number; priceCents: number };
type Slot = { startsAt: string; label: string };
type DaySlots = { date: string; slots: Slot[] };

type Props = {
  services: Service[];
  timezone: string;
  today: string; // shop calendar date, "YYYY-MM-DD"
  lastDate: string; // last bookable date
  depositCents: number;
  cancellationDays: number;
  me: Me | null; // signed-in customer, if any
  initialServiceId?: string | null; // from "Book again"
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const monthOf = (date: string) => date.slice(0, 7); // "YYYY-MM"
const firstOfMonth = (month: string) => `${month}-01`;
function lastOfMonth(month: string) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
function shiftMonth(month: string, by: number) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7);
}
function monthLabel(month: string) {
  const [y, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 1)));
}

export default function BookingFlow(props: Props) {
  const { services, timezone, today, lastDate, depositCents, cancellationDays } = props;
  const [me, setMe] = useState<Me | null>(props.me);
  const [serviceId, setServiceId] = useState<string | null>(
    services.some((s) => s.id === props.initialServiceId) ? props.initialServiceId! : null,
  );
  const [month, setMonth] = useState(monthOf(today));
  const [days, setDays] = useState<Record<string, Slot[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const timesRef = useRef<HTMLElement>(null);

  const service = services.find((s) => s.id === serviceId) ?? null;

  // Load a month of free slots whenever the service or month changes.
  useEffect(() => {
    if (!serviceId) return;
    const from = firstOfMonth(month) < today ? today : firstOfMonth(month);
    const to = lastOfMonth(month) > lastDate ? lastDate : lastOfMonth(month);
    if (from > to) return;

    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/slots?serviceId=${serviceId}&from=${from}&to=${to}`, { signal: controller.signal, cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Couldn't load times.");
        return res.json() as Promise<{ days: DaySlots[] }>;
      })
      .then((data) => {
        setDays(Object.fromEntries(data.days.map((d) => [d.date, d.slots])));
        setLoading(false);
      })
      .catch((e: Error) => {
        if (controller.signal.aborted) return;
        setError(e.message);
        setLoading(false);
      });
    return () => controller.abort();
  }, [serviceId, month, today, lastDate, reloadKey]);

  // If the chosen time disappears after a reload (someone else took it), clear it.
  useEffect(() => {
    if (slot && date && !(days[date] ?? []).some((s) => s.startsAt === slot.startsAt)) setSlot(null);
  }, [days, date, slot]);

  function chooseService(id: string) {
    setServiceId(id);
    setDays({});
    setDate(null);
    setSlot(null);
  }

  function chooseDate(d: string) {
    setDate(d);
    setSlot(null);
    setNotice(null);
    // On phones the times are below the calendar; bring them into view.
    requestAnimationFrame(() => timesRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  }

  const grid = useMemo(() => {
    const first = firstOfMonth(month);
    const cells: (string | null)[] = Array(weekdayOf(first)).fill(null);
    for (let d = first; d <= lastOfMonth(month); d = addDays(d, 1)) cells.push(d);
    return cells;
  }, [month]);

  const canGoBack = month > monthOf(today);
  const canGoForward = month < monthOf(lastDate);
  const times = date ? days[date] ?? [] : [];

  return (
    <div className="flow">
      <section aria-labelledby="step-service">
        <h2 id="step-service" className="step">1. Choose a service</h2>
        <div className="services" role="radiogroup" aria-label="Service">
          {services.map((s) => (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={s.id === serviceId}
              className="service choice"
              onClick={() => chooseService(s.id)}
            >
              <span>
                <strong>{s.name}</strong>
                {s.description && <span className="muted block">{s.description}</span>}
              </span>
              <span className="price">
                {formatCents(s.priceCents)}
                <span className="muted block">{s.durationMin} min</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      {service && (
        <section aria-labelledby="step-date">
          <h2 id="step-date" className="step">2. Pick a day</h2>
          <div className="calendar">
            <div className="calendar-head">
              <button type="button" className="icon-button" onClick={() => setMonth(shiftMonth(month, -1))} disabled={!canGoBack} aria-label="Previous month">
                ‹
              </button>
              <span aria-live="polite">{monthLabel(month)}</span>
              <button type="button" className="icon-button" onClick={() => setMonth(shiftMonth(month, 1))} disabled={!canGoForward} aria-label="Next month">
                ›
              </button>
            </div>
            <div className="calendar-grid" role="grid" aria-busy={loading}>
              {WEEKDAYS.map((w) => (
                <span key={w} className="weekday" aria-hidden="true">
                  {w}
                </span>
              ))}
              {grid.map((d, i) => {
                if (!d) return <span key={`pad-${i}`} />;
                const free = (days[d]?.length ?? 0) > 0;
                const label = `${formatDateLong(new Date(`${d}T12:00:00Z`), "UTC")}${free ? "" : ", no times free"}`;
                return (
                  <button
                    key={d}
                    type="button"
                    className={`day${d === date ? " selected" : ""}${d === today ? " today" : ""}`}
                    disabled={loading || !free}
                    aria-pressed={d === date}
                    aria-label={label}
                    onClick={() => chooseDate(d)}
                  >
                    {Number(d.slice(8))}
                  </button>
                );
              })}
            </div>
            {loading && <p className="muted small">Checking Jess&apos;s calendar…</p>}
            {error && (
              <p className="error" role="alert">
                {error}{" "}
                <button type="button" className="link-button" onClick={() => setReloadKey((k) => k + 1)}>
                  Try again
                </button>
              </p>
            )}
            {!loading && !error && Object.values(days).every((s) => s.length === 0) && (
              <p className="muted small">No free times this month. Try the next one.</p>
            )}
          </div>
        </section>
      )}

      {service && date && (
        <section aria-labelledby="step-time" ref={timesRef}>
          <h2 id="step-time" className="step">3. Pick a time on {formatDateLong(new Date(`${date}T12:00:00Z`), "UTC")}</h2>
          {notice && (
            <p className="error" role="alert">
              {notice}
            </p>
          )}
          {times.length === 0 ? (
            <p className="muted">No free times left on this day.</p>
          ) : (
            <div className="times" role="radiogroup" aria-label="Start time">
              {times.map((t) => (
                <button
                  key={t.startsAt}
                  type="button"
                  role="radio"
                  aria-checked={slot?.startsAt === t.startsAt}
                  className="time choice"
                  onClick={() => {
                    setSlot(t);
                    setNotice(null);
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {service && slot && (
        <Summary
          me={me}
          onMeChange={setMe}
          service={service}
          startsAt={new Date(slot.startsAt)}
          timezone={timezone}
          depositCents={depositCents}
          cancellationDays={cancellationDays}
          onSlotGone={(message) => {
            // Someone else got there first: show fresh times and say why.
            setNotice(message);
            setSlot(null);
            setReloadKey((k) => k + 1);
            requestAnimationFrame(() => timesRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
          }}
        />
      )}
    </div>
  );
}

function Summary(props: {
  me: Me | null;
  onMeChange: (me: Me | null) => void;
  service: Service;
  startsAt: Date;
  timezone: string;
  depositCents: number;
  cancellationDays: number;
  onSlotGone: (message: string) => void;
}) {
  const { service, startsAt, timezone, depositCents, cancellationDays, onSlotGone } = props;
  const endsAt = new Date(startsAt.getTime() + service.durationMin * 60_000);
  const deadline = refundDeadline(startsAt, cancellationDays);
  const refundable = isRefundable(startsAt, new Date(), cancellationDays);

  return (
    <section className="summary" aria-labelledby="summary-title">
      <h2 id="summary-title" className="step">Your appointment</h2>
      <dl>
        <dt>Service</dt>
        <dd>{service.name}</dd>
        <dt>When</dt>
        <dd>
          {formatDateLong(startsAt, timezone)}, {formatTime(startsAt, timezone)}–{formatTime(endsAt, timezone)}
        </dd>
        <dt>Price</dt>
        <dd>{formatCents(service.priceCents)}</dd>
        <dt>Deposit today</dt>
        <dd>{formatCents(depositCents)}</dd>
        <dt>Pay on the day</dt>
        <dd>{formatCents(balanceDueCents(service.priceCents, depositCents))}</dd>
      </dl>
      {refundable ? (
        <p className="note">
          Cancel by {formatDateLong(deadline, timezone)}, {formatTime(deadline, timezone)} for a full refund of your deposit.
        </p>
      ) : (
        <p className="note warning">
          This appointment is less than {cancellationDays} days away, so the {formatCents(depositCents)} deposit can&apos;t be
          refunded if you cancel.
        </p>
      )}
      <DetailsForm
        key={`${startsAt.toISOString()}-${props.me?.phone ?? ""}`}
        me={props.me}
        onMeChange={props.onMeChange}
        serviceId={service.id}
        startsAt={startsAt.toISOString()}
        depositCents={depositCents}
        refundable={refundable}
        onSlotGone={onSlotGone}
      />
    </section>
  );
}
