"use client";

import { useState } from "react";
import PhoneSignIn from "@/components/PhoneSignIn";
import { DOG_SIZES } from "@/lib/dogs";
import { formatCents } from "@/lib/money";
import { formatUsPhone } from "@/lib/phone";
import type { Me } from "@/lib/session";

type Props = {
  me: Me | null;
  onMeChange: (me: Me | null) => void;
  serviceId: string;
  startsAt: string;
  depositCents: number;
  refundable: boolean;
  onSlotGone: (message: string) => void;
};

const NEW_DOG = "new";

export default function DetailsForm({ me, onMeChange, serviceId, startsAt, depositCents, refundable, onSlotGone }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dogChoice, setDogChoice] = useState<string>(me?.dogs[0]?.id ?? NEW_DOG);

  async function loadMe() {
    const res = await fetch("/api/me", { cache: "no-store" });
    const data: Me | null = res.ok ? await res.json() : null;
    onMeChange(data);
    setDogChoice(data?.dogs[0]?.id ?? NEW_DOG);
  }

  async function signOut() {
    await fetch("/api/auth/sign-out", { method: "POST" });
    onMeChange(null);
  }

  if (!me) {
    return (
      <div className="details">
        <h3 className="substep">Confirm your mobile number</h3>
        <PhoneSignIn intro="We'll text you a code. Your number is also where your reminder goes." onSignedIn={loadMe} />
      </div>
    );
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const value = (k: string) => String(form.get(k) ?? "").trim();
    setBusy(true);
    setError(null);

    const dog =
      dogChoice === NEW_DOG
        ? { name: value("dogName"), breed: value("breed"), size: value("size"), notes: value("notes") }
        : { id: dogChoice };

    const res = await fetch("/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serviceId,
        startsAt,
        customer: { name: value("name"), email: value("email") },
        dog,
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
    if (res?.status === 401) {
      onMeChange(null); // session ended; ask for the code again
      return;
    }
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
        <p className="signed-in">
          Texts go to <strong>{formatUsPhone(me.phone)}</strong>.{" "}
          <button type="button" className="link-button" onClick={signOut}>
            Not you?
          </button>
        </p>
        <label>
          Your name
          <input name="name" required maxLength={100} autoComplete="name" defaultValue={me.name} />
        </label>
        <label>
          Email <span className="muted">(optional, for your receipt)</span>
          <input name="email" type="email" maxLength={200} autoComplete="email" defaultValue={me.email} />
        </label>
      </fieldset>

      <fieldset>
        <legend>Which dog?</legend>
        {me.dogs.length > 0 && (
          <div className="dog-choices">
            {me.dogs.map((d) => (
              <label key={d.id} className="check">
                <input type="radio" name="dogChoice" checked={dogChoice === d.id} onChange={() => setDogChoice(d.id)} />
                <span>
                  {d.name}
                  {d.breed && <span className="muted"> · {d.breed}</span>}
                </span>
              </label>
            ))}
            <label className="check">
              <input type="radio" name="dogChoice" checked={dogChoice === NEW_DOG} onChange={() => setDogChoice(NEW_DOG)} />
              <span>A different dog</span>
            </label>
          </div>
        )}
        {dogChoice === NEW_DOG && (
          <>
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
                {DOG_SIZES.map((s) => (
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
          </>
        )}
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
