import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { supabase } from "../lib/supabase";
import { AuthLayout, FormError } from "./AuthLayout";

type Step = "checking" | "invalid" | "password" | "done";

/**
 * ORG-03: the invite email lands here with `?token_hash=…&type=invite`. Verify it,
 * have the person set a password, then point them at the desktop agent.
 */
export function Join() {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>("checking");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tokenHash = params.get("token_hash");
    let cancelled = false;
    (async () => {
      if (tokenHash && params.get("type") === "invite") {
        const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: "invite" });
        // Keep the one-time token out of history and referrers either way.
        window.history.replaceState(null, "", "/join");
        if (!cancelled) setStep(error ? "invalid" : "password");
        return;
      }
      const { data } = await supabase.auth.getSession();
      if (!cancelled) setStep(data.session ? "password" : "invalid");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const password = String(new FormData(e.currentTarget).get("password"));
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) return setError(error.message);
    await queryClient.invalidateQueries({ queryKey: ["profile"] });
    setStep("done");
  };

  if (step === "checking") {
    return (
      <AuthLayout title="Joining…">
        <p className="text-sm text-ink2">Checking your invite.</p>
      </AuthLayout>
    );
  }
  if (step === "invalid") {
    return (
      <AuthLayout title="This invite doesn't work">
        <p className="text-sm text-ink2">
          The link has expired or was already used. Ask your admin to invite you again, or sign in
          if you already set a password.
        </p>
        <Link to="/sign-in" className="text-[13px] font-medium text-acctext">
          Sign in
        </Link>
      </AuthLayout>
    );
  }
  if (step === "password") {
    return (
      <AuthLayout title="Set your password">
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
            />
          </div>
          <FormError message={error} />
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Continue"}
          </Button>
        </form>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title="You're in">
      <AgentDownloads />
      <Link to="/" className="text-[13px] font-medium text-acctext">
        Go to the dashboard
      </Link>
    </AuthLayout>
  );
}

function AgentDownloads() {
  const mac = import.meta.env.VITE_AGENT_DOWNLOAD_MAC;
  const windows = import.meta.env.VITE_AGENT_DOWNLOAD_WINDOWS;
  return (
    <div className="flex flex-col gap-3 text-sm text-ink2">
      <p>
        Install the AI Proctor desktop agent and sign in with this email. It runs only while you're
        clocked in, and shows you what it records before it starts.
      </p>
      {mac || windows ? (
        <div className="flex flex-wrap gap-2">
          {mac && (
            <a href={mac} className="font-medium text-acctext">
              Download for Mac
            </a>
          )}
          {windows && (
            <a href={windows} className="font-medium text-acctext">
              Download for Windows
            </a>
          )}
        </div>
      ) : (
        <p>Your admin will send you the installer.</p>
      )}
    </div>
  );
}
