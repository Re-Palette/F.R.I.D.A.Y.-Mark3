"use client";

import { useState, type FormEvent } from "react";
import { HudFrame } from "@/components/HudFrame";

export default function LoginPage() {
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!passcode.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode }),
      });
      const json = (await res.json()) as { ok: boolean; message?: string };
      if (json.ok) {
        window.location.href = "/";
        return;
      }
      setError(json.message ?? "ログインできませんでした。");
    } catch {
      setError("サーバーに接続できませんでした。");
    }
    setBusy(false);
  };

  return (
    <main className="login">
      <div className="bg" aria-hidden="true">
        <div className="bg__glow" />
        <div className="bg__scan" />
      </div>
      <form className="login__box hud" onSubmit={submit}>
        <HudFrame cut={18} leds notch />
        <div className="login__brand">
          F.R.I.D.A.Y. <span>Mark3</span>
        </div>
        <div className="login__sub">ACCESS CONTROL // PASSCODE REQUIRED</div>
        <label className="login__label" htmlFor="passcode">
          合言葉
        </label>
        <input
          id="passcode"
          className="login__input"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={passcode}
          onChange={(e) => setPasscode(e.target.value)}
        />
        {error && (
          <p className="login__error" role="alert">
            {error}
          </p>
        )}
        <button className="login__btn" type="submit" disabled={busy || !passcode.trim()}>
          {busy ? "VERIFYING…" : "UNLOCK"}
        </button>
      </form>
    </main>
  );
}
