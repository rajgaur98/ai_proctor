// Calls to our Edge Functions that need the raw response (a streamed ZIP, or an error
// code and message to show), with the signed-in token. supabase.functions.invoke hides both.
import { supabase } from "./supabase";

/** An error reply from a function: `code` is its `error` field, `message` is for people. */
export class FunctionError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message);
  }
}

/** POSTs to a function; throws a FunctionError (with the function's own message) unless it is a 2xx. */
export async function callFunction(
  name: string,
  body: unknown,
  failure: string,
): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new FunctionError("Sign in again and retry.", null);

  const request: RequestInit = {
    method: "POST",
    headers: {
      // Both are checked when the client in lib/supabase.ts is created.
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
  };
  if (body !== undefined) request.body = JSON.stringify(body);
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${name}`, request);
  if (!res.ok) {
    const reply = (await res.json().catch(() => null)) as {
      error?: string;
      message?: string;
      reports?: string;
    } | null;
    const message = reply?.message ?? failure;
    throw new FunctionError(
      reply?.reports ? `${message} Reports: ${reply.reports}.` : message,
      reply?.error ?? null,
    );
  }
  return res;
}

/** Hands a downloaded file to the browser, named by the reply's Content-Disposition. */
export async function saveDownload(res: Response, fallbackName: string): Promise<void> {
  const name =
    res.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  // After the browser has taken the file.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
