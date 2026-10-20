// "Export my data" (EMP-04): calls the export-my-data Edge Function with the signed-in
// token and hands the ZIP to the browser as a download. The function streams the
// archive; the data and images are the caller's own (checked there, not here).
import { supabase } from "../../lib/supabase";

export async function exportMyData(): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Sign in again to export your data.");

  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/export-my-data`, {
    method: "POST",
    headers: {
      // Both are checked when the client in lib/supabase.ts is created.
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? "The export failed. Try again.");
  }
  const name =
    res.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ??
    "ai-proctor-my-data.zip";
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
