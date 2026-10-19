import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { supabase } from "../lib/supabase";
import { AuthLayout, FormError } from "./AuthLayout";

/** NFR-SEC-05: enrol a TOTP authenticator, or verify one for this session. */
export function Mfa() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [factorId, setFactorId] = useState<string | null>(null);
  const [enrolling, setEnrolling] = useState<{ qr: string; secret: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.auth.mfa.listFactors();
      if (error) return setError(error.message);
      const verified = data.totp[0];
      if (verified) return setFactorId(verified.id);
      const enrolled = await supabase.auth.mfa.enroll({ factorType: "totp" });
      if (enrolled.error) return setError(enrolled.error.message);
      setFactorId(enrolled.data.id);
      setEnrolling({ qr: enrolled.data.totp.qr_code, secret: enrolled.data.totp.secret });
    })();
  }, []);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!factorId) return;
    setBusy(true);
    setError(null);
    const code = String(new FormData(e.currentTarget).get("code")).replace(/\s/g, "");
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
    setBusy(false);
    if (error) return setError(error.message);
    await queryClient.invalidateQueries();
    await navigate({ to: "/" });
  };

  return (
    <AuthLayout title="Two-factor authentication">
      {enrolling ? (
        <div className="flex flex-col gap-3 text-sm text-ink2">
          <p>Scan this with your authenticator app, then enter the 6-digit code.</p>
          <img
            src={enrolling.qr}
            alt="Authenticator QR code"
            className="h-44 w-44 self-center bg-white p-2"
          />
          <p className="text-[12.5px]">
            Can't scan it? Enter <span className="font-mono">{enrolling.secret}</span>
          </p>
        </div>
      ) : (
        <p className="text-sm text-ink2">Enter the 6-digit code from your authenticator app.</p>
      )}
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="code">Code</Label>
          <Input
            id="code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 ]{6,7}"
            required
          />
        </div>
        <FormError message={error} />
        <Button type="submit" disabled={busy || !factorId}>
          {busy ? "Checking…" : "Verify"}
        </Button>
      </form>
    </AuthLayout>
  );
}
