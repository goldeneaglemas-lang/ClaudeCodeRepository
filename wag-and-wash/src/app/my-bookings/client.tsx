"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import PhoneSignIn from "@/components/PhoneSignIn";
import { DOG_SIZES } from "@/lib/dogs";
import type { Me } from "@/lib/session";

async function send(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => null);
  const data = await res?.json().catch(() => null);
  return { ok: !!res?.ok, data };
}

export function SignInPanel() {
  const router = useRouter();
  return <PhoneSignIn intro="Sign in with the mobile number you booked with." onSignedIn={() => router.refresh()} />;
}

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      className="link-button"
      onClick={async () => {
        await send("/api/auth/sign-out", "POST");
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}

export function CancelBooking({ bookingId, refundable, deposit }: { bookingId: string; refundable: boolean; deposit: string }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (!asking) {
    return (
      <button type="button" className="button secondary" onClick={() => setAsking(true)}>
        Cancel booking
      </button>
    );
  }

  async function cancel() {
    setBusy(true);
    const { ok, data } = await send(`/api/bookings/${bookingId}/cancel`, "POST");
    setBusy(false);
    if (!ok) {
      setMessage(data?.error ?? "Couldn't cancel. Please try again.");
      return;
    }
    setMessage(
      data.refunded
        ? `Cancelled. Your ${deposit} deposit is on its way back to your card (5–10 days).`
        : refundable
          ? "Cancelled. We couldn't refund the deposit automatically; Jess will sort it out."
          : "Cancelled.",
    );
    setTimeout(() => router.refresh(), 2500);
  }

  return (
    <div className="confirm-box" role="alertdialog" aria-label="Cancel this booking?">
      {message ? (
        <p role="status">{message}</p>
      ) : (
        <>
          <p>
            <strong>Cancel this booking?</strong>{" "}
            {refundable ? `Your ${deposit} deposit will be refunded.` : `Your ${deposit} deposit won't be refunded.`}
          </p>
          <div className="row">
            <button type="button" className="button danger" disabled={busy} onClick={cancel}>
              {busy ? "Cancelling…" : "Yes, cancel"}
            </button>
            <button type="button" className="button secondary" disabled={busy} onClick={() => setAsking(false)}>
              Keep it
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function DogEditor({ dog }: { dog: Me["dogs"][number] }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!editing) {
    return (
      <div className="dog-row">
        <div>
          <h3>{dog.name}</h3>
          <p className="small muted">
            {[dog.breed, DOG_SIZES.find((s) => s.value === dog.size)?.label].filter(Boolean).join(" · ")}
          </p>
          {dog.notes && <p className="small">{dog.notes}</p>}
        </div>
        <button type="button" className="link-button" onClick={() => setEditing(true)}>
          Edit
        </button>
      </div>
    );
  }

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const v = (k: string) => String(f.get(k) ?? "").trim();
    const { ok, data } = await send(`/api/me/dogs/${dog.id}`, "PATCH", {
      name: v("name"),
      breed: v("breed"),
      size: v("size"),
      notes: v("notes"),
    });
    if (!ok) return setError(data?.error ?? "Couldn't save.");
    setEditing(false);
    router.refresh();
  }

  return (
    <form className="details" onSubmit={save}>
      <label>
        Name
        <input name="name" required maxLength={60} defaultValue={dog.name} />
      </label>
      <label>
        Breed
        <input name="breed" maxLength={60} defaultValue={dog.breed ?? ""} />
      </label>
      <label>
        Size
        <select name="size" defaultValue={dog.size}>
          {DOG_SIZES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Notes for Jess
        <textarea name="notes" rows={3} maxLength={1000} defaultValue={dog.notes ?? ""} />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row">
        <button type="submit" className="button">Save</button>
        <button type="button" className="button secondary" onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function ReminderToggle({ initial }: { initial: boolean }) {
  const [on, setOn] = useState(initial);
  const [error, setError] = useState(false);
  return (
    <>
      <label className="check">
        <input
          type="checkbox"
          checked={on}
          onChange={async (e) => {
            // Switch at once; put it back if saving fails.
            const next = e.target.checked;
            setOn(next);
            setError(false);
            const { ok } = await send("/api/me/preferences", "PATCH", { smsOptIn: next });
            if (!ok) {
              setOn(!next);
              setError(true);
            }
          }}
        />
        <span>Text me a reminder before each appointment</span>
      </label>
      {error && (
        <p className="error small" role="alert">
          Couldn&apos;t save that. Please try again.
        </p>
      )}
    </>
  );
}
