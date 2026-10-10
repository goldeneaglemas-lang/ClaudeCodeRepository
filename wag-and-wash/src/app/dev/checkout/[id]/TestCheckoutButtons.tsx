"use client";

import { useState } from "react";

export default function TestCheckoutButtons(props: { checkoutId: string; successUrl: string; cancelUrl: string; amount: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pay() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/dev/checkout/${props.checkoutId}/pay`, { method: "POST" });
    if (res.ok) {
      window.location.href = props.successUrl;
    } else {
      setError((await res.json().catch(() => null))?.error ?? "Payment failed.");
      setBusy(false);
    }
  }

  return (
    <div className="actions">
      <button type="button" className="button" onClick={pay} disabled={busy}>
        {busy ? "Paying…" : `Pay ${props.amount} (test)`}
      </button>
      <a className="link" href={props.cancelUrl}>
        Cancel and go back
      </a>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
