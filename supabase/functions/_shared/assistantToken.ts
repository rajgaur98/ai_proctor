// AI assistants' tokens (#307, API-07) are for the MCP server only. Supabase Auth's OAuth
// server issues them to a third-party client (Claude, ChatGPT, ...) as ordinary session
// tokens with a `client_id` claim; the access token hook also gives them the role
// `ai_assistant`, which PostgREST, Storage and Realtime refuse. The Edge Functions that
// take a person's token and then act with the service role refuse them here, so an
// assistant can't export, delete, invite or view captures through them.

/** True for a bearer token issued to an OAuth client. It only reads the claims: the
 * caller still checks the token with Auth before trusting anything else in it. */
export function isAssistantToken(authorization: string | null): boolean {
  const token = (authorization ?? "").replace(/^Bearer\s+/i, "");
  const part = token.split(".")[1];
  if (!part) return false;
  try {
    const claims = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
    return (
      (typeof claims?.client_id === "string" && claims.client_id !== "") ||
      claims?.role === "ai_assistant"
    );
  } catch {
    return false;
  }
}
