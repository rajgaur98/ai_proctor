// Data subject requests for another person (#54, ADM-05): the admin's export and
// permanent deletion. Both functions check the typed email, the admin's role and MFA
// again; this only sends the request.
import { callFunction, saveDownload } from "../../lib/functions";

export interface DeletedData {
  ok: true;
  images_removed: number;
  /** Rows removed, per table. */
  counts: Record<string, number>;
}

export async function exportUserData(userId: string, email: string): Promise<void> {
  const res = await callFunction(
    "export-user-data",
    { user_id: userId, email },
    "The export failed. Try again.",
  );
  await saveDownload(res, "ai-proctor-user-data.zip");
}

export async function deleteUserData(userId: string, email: string): Promise<DeletedData> {
  const res = await callFunction(
    "delete-user-data",
    { user_id: userId, email },
    "The deletion failed. Try again.",
  );
  return (await res.json()) as DeletedData;
}
