// Settings → API → AI assistants (#307, API-07): owners and admins turn AI assistant
// access on or off for the org (off by default). While it is on, people connect Claude,
// ChatGPT and other assistants to the MCP server and ask about what they can see. The
// database audit-logs the change and updates the monitoring notice (ADM-06).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { assistantAccessQuery, mcpServerUrl, setAssistantAccess } from "./assistantData";
import { type AccessChange, noticeOutcome } from "./assistantText";

const dialogClass =
  "m-auto w-[min(560px,calc(100vw-32px))] rounded-xl border border-line bg-panel p-6 text-ink backdrop:bg-black/30";

export function AssistantAccess({ orgName }: { orgName: string }) {
  const access = useQuery(assistantAccessQuery);
  const [asking, setAsking] = useState<boolean | null>(null);
  const [changed, setChanged] = useState<AccessChange | null>(null);
  const on = access.data === true;

  return (
    <section
      aria-labelledby="ai-assistants-title"
      className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-5 text-[13.5px]"
    >
      <h2 id="ai-assistants-title" className="text-sm font-semibold">
        AI assistants
      </h2>
      <p className="max-w-[720px] text-ink2">
        People can connect Claude, ChatGPT and other AI assistants (over MCP) and ask about what
        they can see here: who is working, a person's day, timesheets, hours and alerts. An
        assistant signs in as the person, sees exactly what they see, can only read, never gets
        captures, window titles or websites, and every question it asks is in the audit log.
      </p>
      <label className="flex min-h-11 cursor-pointer items-center gap-3 font-medium">
        <input
          type="checkbox"
          checked={on}
          disabled={access.isPending || !!access.error}
          onChange={(e) => setAsking(e.target.checked)}
          className="h-5 w-5 flex-none accent-acc"
        />
        Allow AI assistant access
      </label>
      {access.error && (
        <p role="alert" className="text-warnink">
          Couldn't load this: {access.error.message}
        </p>
      )}
      <p role="status" className="text-ink2 empty:hidden">
        {changed ? noticeOutcome(changed) : ""}
        {changed?.notice_edited && (
          <>
            {" "}
            <Link to="/notice" className="underline">
              Open the notice
            </Link>
          </>
        )}
      </p>
      {on && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mcp-server-url">MCP server URL</Label>
            <Input
              id="mcp-server-url"
              readOnly
              value={mcpServerUrl}
              onFocus={(e) => e.target.select()}
              className="max-w-[560px] font-mono text-[12.5px]"
            />
          </div>
          <p className="max-w-[720px] text-ink2">
            In Claude, add it under Settings, Connectors, Add custom connector; in other assistants,
            add it as a remote MCP server. Each person then signs in with their own AI Proctor
            account and approves the assistant.
          </p>
        </div>
      )}
      {asking !== null && (
        <ConfirmDialog
          enable={asking}
          orgName={orgName}
          onDone={(change) => {
            setAsking(null);
            if (change) setChanged(change);
          }}
        />
      )}
    </section>
  );
}

function ConfirmDialog({
  enable,
  orgName,
  onDone,
}: {
  enable: boolean;
  orgName: string;
  onDone: (change: AccessChange | null) => void;
}) {
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: () => setAssistantAccess(enable),
    onSuccess: (change) => {
      queryClient.setQueryData(assistantAccessQuery.queryKey, change.enabled);
      onDone(change);
    },
  });
  const title = enable ? "Turn on AI assistant access?" : "Turn off AI assistant access?";

  return (
    <dialog
      ref={(el) => {
        if (el && !el.open) el.showModal();
      }}
      onClose={() => onDone(null)}
      aria-labelledby="ai-access-title"
      className={dialogClass}
    >
      <form
        method="dialog"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!save.isPending) save.mutate();
        }}
      >
        <h2 id="ai-access-title" className="text-lg font-semibold">
          {title}
        </h2>
        <p className="text-sm text-ink2">
          {enable
            ? `Everyone at ${orgName} can connect an AI assistant to read what they can see in AI Proctor. The assistant's provider receives that data.`
            : "Connected assistants stop getting data at once, and nobody can connect a new one."}{" "}
          If the monitoring notice still uses the template text, a new version that says so is
          published and everyone acknowledges it again.
        </p>
        {save.error && (
          <p role="alert" className="text-sm text-warnink">
            {save.error.message}
          </p>
        )}
        <div className="flex gap-2">
          <Button
            type="button"
            variant="secondary"
            className="ml-auto"
            onClick={() => onDone(null)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? "Saving…" : enable ? "Turn on" : "Turn off"}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
