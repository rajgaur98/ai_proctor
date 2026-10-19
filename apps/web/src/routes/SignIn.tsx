import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { oauthProviders } from "../lib/session";
import { supabase } from "../lib/supabase";
import { AuthLayout, FormError } from "./AuthLayout";

const providerLabel = { google: "Continue with Google", azure: "Continue with Microsoft" };

export function SignIn() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({
      email: String(form.get("email")),
      password: String(form.get("password")),
    });
    setBusy(false);
    if (error) return setError(error.message);
    await navigate({ to: "/" });
  };

  return (
    <AuthLayout title="Sign in">
      {oauthProviders().map((provider) => (
        <Button
          key={provider}
          variant="secondary"
          onClick={() =>
            supabase.auth.signInWithOAuth({
              provider,
              options: { redirectTo: window.location.origin },
            })
          }
        >
          {providerLabel[provider]}
        </Button>
      ))}
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">Work email</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </div>
        <FormError message={error} />
        <Button type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
      <p className="text-[13px] text-ink2">
        New organisation?{" "}
        <Link to="/sign-up" className="font-medium text-acctext">
          Create an account
        </Link>
      </p>
    </AuthLayout>
  );
}
