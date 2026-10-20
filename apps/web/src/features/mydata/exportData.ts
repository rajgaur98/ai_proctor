// "Export my data" (EMP-04): calls the export-my-data Edge Function with the signed-in
// token and hands the ZIP to the browser as a download. The function streams the
// archive; the data and images are the caller's own (checked there, not here).
import { callFunction, saveDownload } from "../../lib/functions";

export async function exportMyData(): Promise<void> {
  const res = await callFunction("export-my-data", undefined, "The export failed. Try again.");
  await saveDownload(res, "ai-proctor-my-data.zip");
}
