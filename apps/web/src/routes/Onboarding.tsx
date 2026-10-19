import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { supabase } from "../lib/supabase";
import { viewerZone } from "../lib/time";
import { AuthLayout, FormError } from "./AuthLayout";

/** ORG-01/02: name the organisation and pick the region preset (US data region only during pilots). */
export function Onboarding() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    const { data: auth } = await supabase.auth.getUser();
    const { error } = await supabase.rpc("create_org", {
      org_name: String(form.get("org")),
      region_preset: form.get("preset") as "us" | "eu" | "india",
      full_name: String(auth.user?.user_metadata.full_name ?? ""),
      timezone: viewerZone(),
    });
    if (error) {
      setBusy(false);
      return setError(error.message);
    }
    // The new org_id claim only appears in a freshly minted token.
    await supabase.auth.refreshSession();
    await queryClient.invalidateQueries();
    await navigate({ to: "/" });
  };

  return (
    <AuthLayout title="Create your organisation">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="org">Organisation name</Label>
          <Input id="org" name="org" required maxLength={120} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="preset">Policy preset</Label>
          <select
            id="preset"
            name="preset"
            className="h-11 rounded-[9px] border border-line2 bg-panel px-3 text-sm"
          >
            <option value="us">United States</option>
            <option value="eu">European Union</option>
            <option value="india">India</option>
          </select>
          <span className="text-[12.5px] text-ink3">
            Data is stored in the US during the pilot.
          </span>
        </div>
        <FormError message={error} />
        <Button type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create organisation"}
        </Button>
      </form>
    </AuthLayout>
  );
}
