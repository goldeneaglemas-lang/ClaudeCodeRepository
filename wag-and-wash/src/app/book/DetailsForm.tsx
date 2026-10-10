"use client";

import { useState } from "react";
import { formatCents } from "@/lib/money";

type Props = {
  serviceId: string;
  startsAt: string;
  depositCents: number;
  refundable: boolean;
  onSlotGone: (message: string) => void;
};

const SIZES = [
  { value: "small", label: "Small (under 20 lb)" },
  { value: "medium", label: "Medium (20–50 lb)" },
  { value: "large", label: "Large (50–90 lb)" },
  { value: "xl", label: "Extra large (over 90 lb)" },
];

export default function DetailsForm({ serviceId, startsAt, depositCents, refundable, onSlotGone }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const value = (k: string) => String(form.get(k) ?? "").trim();
    setBusy(true);
    setError(null);

    const res = await fetch("/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serviceId,
        startsAt,
        customer: { name: value("name"), phone: value("phone"), email: value("email") },
        dog: { name: value("dogName"), breed: value("breed"), size: value("size"), notes: value("notes") },
        acceptNonRefundable: form.get("acceptNonRefundable") === "on",
      }),
    }).catch(() => null);

    if (res?.status === 201) {
      const { checkoutUrl } = await res.json();
      window.location.href = checkoutUrl; // Stripe's payment page (or the test one)
      return;
    }
    const body = await res?.json().catch(() => null);
    setBusy(false);
    if (res?.status === 409) {
      onSlotGone(body?.error ?? "Sorry, that time has just gone. Please pick another.");
      return;
    }
    setError(body?.error ?? "Something went wrong. Please try again.");
  }

  return (
    <form className="details" onSubmit={submit}>
      <fieldset>
        <legend>About you</legend>
        <label>
          Your name
          <input name="name" required maxLength={100} autoComplete="name" />
        </label>
        <label>
          Mobile number <span className="muted">(for your reminder text)</span>
          <input name="phone" type="tel" required inputMode="tel" autoComplete="tel" placeholder="(555) 123-4567" />
        </label>
        <label>
          Email <span className="muted">(optional, for your receipt)</span>
          <input name="email" type="email" maxLength={200} autoComplete="email" />
        </label>
      </fieldset>

      <fieldset>
        <legend>About your dog</legend>
        <label>
          Dog&apos;s name
          <input name="dogName" required maxLength={60} />
        </label>
        <label>
          Breed <span className="muted">(optional)</span>
          <input name="breed" maxLength={60} />
        </label>
        <label>
          Size
          <select name="size" required defaultValue="">
            <option value="" disabled>
              Choose a size
            </option>
            {SIZES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Anything Jess should know? <span className="muted">(optional)</span>
          <textarea name="notes" rows={3} maxLength={1000} placeholder="Nervous of dryers, skin allergies, last groom…" />
        </label>
      </fieldset>

      {!refundable && (
        <label className="check">
          <input type="checkbox" name="acceptNonRefundable" required />
          <span>I understand the {formatCents(depositCents)} deposit can&apos;t be refunded for this appointment.</span>
        </label>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="button" disabled={busy}>
        {busy ? "Opening payment…" : `Pay ${formatCents(depositCents)} deposit`}
      </button>
      <p className="muted small">Payments are handled securely by Stripe. We never see your card details.</p>
    </form>
  );
}
