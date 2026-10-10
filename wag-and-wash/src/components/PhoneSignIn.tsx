"use client";

import { useEffect, useState } from "react";

/** Two steps: type your mobile number, then the 6-digit code texted to it. */
export default function PhoneSignIn({ onSignedIn, intro }: { onSignedIn: () => void; intro?: string }) {
  const [phone, setPhone] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  async function post(url: string, body: unknown) {
    setBusy(true);
    setError(null);
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(
      () => null,
    );
    const data = await res?.json().catch(() => null);
    setBusy(false);
    if (!res?.ok) setError(data?.error ?? "Something went wrong. Please try again.");
    return res?.ok ? data : null;
  }

  async function sendCode(e?: React.FormEvent) {
    e?.preventDefault();
    const data = await post("/api/auth/code", { phone: sentTo ?? phone });
    if (!data) return;
    setSentTo(data.phone);
    setDevCode(data.devCode ?? null);
    setCode("");
    setResendIn(30);
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    if (await post("/api/auth/verify", { phone: sentTo, code })) onSignedIn();
  }

  return (
    <div className="signin">
      {!sentTo ? (
        <form onSubmit={sendCode} className="details">
          {intro && <p className="muted">{intro}</p>}
          <label>
            Mobile number
            <input
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              required
              placeholder="(555) 123-4567"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </label>
          {error && <p className="error" role="alert">{error}</p>}
          <button type="submit" className="button" disabled={busy}>
            {busy ? "Sending…" : "Text me a code"}
          </button>
        </form>
      ) : (
        <form onSubmit={verify} className="details">
          <p>
            We texted a 6-digit code to <strong className="nowrap">{phone || sentTo}</strong>.
          </p>
          {devCode && (
            <p className="test-banner" role="note">
              Test mode: no text was sent. Your code is <strong>{devCode}</strong>.
            </p>
          )}
          <label>
            Code
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              required
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            />
          </label>
          {error && <p className="error" role="alert">{error}</p>}
          <button type="submit" className="button" disabled={busy || code.length !== 6}>
            {busy ? "Checking…" : "Confirm"}
          </button>
          <p className="small">
            <button type="button" className="link-button" disabled={busy || resendIn > 0} onClick={() => sendCode()}>
              {resendIn > 0 ? `Send a new code in ${resendIn}s` : "Send a new code"}
            </button>
            {" · "}
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setSentTo(null);
                setDevCode(null);
                setError(null);
              }}
            >
              Use a different number
            </button>
          </p>
        </form>
      )}
    </div>
  );
}
