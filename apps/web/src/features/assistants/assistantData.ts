// AI assistant access (#307, API-07): the org switch on Settings → API and the OAuth
// consent page. The switch is the org's (owners and admins change it; the database
// audit-logs the change and updates the notice); the consent API is Supabase Auth's
// OAuth server, which asks this page whether the signed-in person lets an assistant in.
import { queryOptions } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";
import { type AccessChange, explainAccessError } from "./assistantText";

/** The MCP server people connect their assistant to (the production host is set at
 * deploy, like the API's). */
export const mcpServerUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/mcp`;

/** Whether the signed-in person's org has AI assistant access on. */
export const assistantAccessQuery = queryOptions({
  queryKey: ["ai-assistant-access"],
  queryFn: async (): Promise<boolean> => {
    const { data, error } = await supabase.from("orgs").select("ai_assistant_access").maybeSingle();
    if (error) throw error;
    return data?.ai_assistant_access ?? false;
  },
});

export async function setAssistantAccess(enabled: boolean): Promise<AccessChange> {
  const { data, error } = await supabase.rpc("set_ai_assistant_access", { p_enabled: enabled });
  if (error) throw new Error(explainAccessError(error.message));
  return data as unknown as AccessChange;
}

export interface ConsentRequest {
  kind: "ask";
  clientName: string;
  email: string;
  redirectUri: string;
}

/** The assistant asking, or where to send the person back to at once (they already
 * approved this assistant). */
export async function authorizationRequest(
  authorizationId: string,
): Promise<ConsentRequest | { kind: "redirect"; url: string }> {
  const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
  if (error || !data) throw new Error(error?.message ?? "This request isn't valid.");
  if ("redirect_url" in data && !("authorization_id" in data)) {
    return { kind: "redirect", url: data.redirect_url };
  }
  const details = data as {
    client: { name: string };
    user: { email: string };
    redirect_uri: string;
  };
  return {
    kind: "ask",
    clientName: details.client.name || "An AI assistant",
    email: details.user.email,
    redirectUri: details.redirect_uri,
  };
}

/** Approves or denies; returns where to send the person back to. */
export async function decide(authorizationId: string, approve: boolean): Promise<string> {
  const options = { skipBrowserRedirect: true };
  const { data, error } = approve
    ? await supabase.auth.oauth.approveAuthorization(authorizationId, options)
    : await supabase.auth.oauth.denyAuthorization(authorizationId, options);
  if (error || !data) throw new Error(error?.message ?? "Couldn't send your answer. Try again.");
  return data.redirect_url;
}
