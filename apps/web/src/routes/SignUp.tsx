import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { supabase } from "../lib/supabase";
import { AuthLayout, FormError } from "./AuthLayout";

/** ORG-01: the owner signs up, then creates the organisation (/onboarding). */
export function SignUp() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkEmail, setCheckEmail] = useState(false);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    const { data, error } = await supabase.auth.signUp({
      email: String(form.get("email")),
      password: String(form.get("password")),
      options: { data: { full_name: String(form.get("name")) } },
    });
    setBusy(false);
    if (error) return setError(error.message);
    if (!data.session) return setCheckEmail(true);
    await navigate({ to: "/onboarding" });
  };

  if (checkEmail) {
    return (
      <AuthLayout title="Check your email">
        <p className="text-sm text-ink2">We sent you a link to confirm your address.</p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Create an account">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="name">Your name</Label>
          <Input id="name" name="name" autoComplete="name" required />
        </div>
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
            autoComplete="new-password"
            minLength={8}
            required
          />
        </div>
        <FormError message={error} />
        <Button type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create account"}
        </Button>
      </form>
      <p className="text-[13px] text-ink2">
        Already have an account?{" "}
        <Link to="/sign-in" className="font-medium text-acctext">
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
}
