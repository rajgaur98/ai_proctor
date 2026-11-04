// The OAuth consent page (#307, API-07): Supabase Auth's OAuth server sends a person here
// when an AI assistant (Claude, ChatGPT, ...) asks to connect to AI Proctor as them. They
// see which assistant, where it sends them back to and what it can read, and allow or deny
// it. While their org has AI assistant access off they can only cancel.
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Button } from "../../components/ui/button";
import type { Profile } from "../../lib/session";
import { AuthLayout, FormError } from "../../routes/AuthLayout";
import { assistantAccessQuery, authorizationRequest, decide } from "./assistantData";
import { returnHost } from "./assistantText";

export function Consent({
  authorizationId,
  profile,
}: {
  authorizationId: string;
  profile: Profile | null;
}) {
  const request = useQuery({
    queryKey: ["oauth-authorization", authorizationId],
    queryFn: () => authorizationRequest(authorizationId),
    enabled: authorizationId !== "",
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const access = useQuery({ ...assistantAccessQuery, enabled: profile !== null });
  const answer = useMutation({
    mutationFn: (approve: boolean) => decide(authorizationId, approve),
  });
  const back = answer.data ?? (request.data?.kind === "redirect" ? request.data.url : null);

  useEffect(() => {
    if (back) window.location.assign(back);
  }, [back]);

  if (back) {
    return (
      <AuthLayout title="Connect an AI assistant">
        <p role="status" className="text-sm text-ink2">
          Returning to your assistant…
        </p>
      </AuthLayout>
    );
  }
  if (!authorizationId || request.error) {
    return (
      <AuthLayout title="Connect an AI assistant">
        <FormError message="This request has expired or isn't valid. Start connecting again from your AI assistant." />
      </AuthLayout>
    );
  }
  if (!profile) {
    return (
      <AuthLayout title="Connect an AI assistant">
        <FormError message="This account isn't a member of an organization in AI Proctor, so there is nothing to connect to." />
      </AuthLayout>
    );
  }
  if (request.isPending || access.isPending) {
    return (
      <AuthLayout title="Connect an AI assistant">
        <p className="text-sm text-ink2">Loading…</p>
      </AuthLayout>
    );
  }
  const ask = request.data.kind === "ask" ? request.data : null;
  if (!ask) return null;
  const off = access.data !== true;

  return (
    <AuthLayout title="Connect an AI assistant">
      <p className="text-[13.5px]">
        <strong className="font-semibold">{ask.clientName}</strong> wants to read your AI Proctor
        data at {profile.orgName} as <span className="font-medium">{ask.email}</span>.
      </p>
      {off ? (
        <FormError
          message={`AI assistant access is off for ${profile.orgName}. Ask an owner or admin to turn it on in Settings, API.`}
        />
      ) : (
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[13px] text-ink2">
          <li>
            It sees what you see in AI Proctor: who is working, people's days, timesheets, hours and
            alerts.
          </li>
          <li>It can only read. It can't change anything.</li>
          <li>It never gets screenshots, webcam frames, window titles or websites.</li>
          <li>Every question it asks is recorded in the audit log.</li>
        </ul>
      )}
      <p className="text-xs text-ink3">
        You go back to <span className="font-medium text-ink2">{returnHost(ask.redirectUri)}</span>.
        Only continue if that is your assistant.
      </p>
      <FormError message={answer.error?.message ?? null} />
      <div className="flex gap-2">
        <Button
          variant="secondary"
          className="flex-1"
          disabled={answer.isPending}
          onClick={() => answer.mutate(false)}
        >
          {off ? "Cancel" : "Deny"}
        </Button>
        {!off && (
          <Button
            className="flex-1"
            disabled={answer.isPending}
            onClick={() => answer.mutate(true)}
          >
            {answer.isPending ? "Allowing…" : "Allow"}
          </Button>
        )}
      </div>
    </AuthLayout>
  );
}
