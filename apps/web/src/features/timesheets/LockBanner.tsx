// The banner on a submitted or approved week (#265, TS-18): locked, by whom and when.
import { useQuery } from "@tanstack/react-query";
import { approverQuery } from "./commentData";
import { lockBannerText } from "./lockBannerText";
import type { Timesheet } from "./timesheetData";

export function LockBanner({
  sheet,
  employeeName,
  viewerId,
}: {
  sheet: Timesheet;
  employeeName: string;
  viewerId: string;
}) {
  const approved = sheet.status === "approved";
  const approver = useQuery({ ...approverQuery(sheet.id, sheet.approvedAt), enabled: approved });
  if (sheet.status !== "submitted" && sheet.status !== "approved") return null;
  // Wait for the approver so the line doesn't change under the reader.
  if (approved && approver.isPending) return null;
  const text = lockBannerText({
    sheet,
    employeeId: sheet.userId,
    employeeName,
    viewerId,
    // Unknown (not "approved on submit") when the approver couldn't be read.
    approverId: approver.data ? approver.data.approverId : approved ? "" : null,
    approverName: approver.data?.approverName ?? null,
  });
  if (!text) return null;
  return (
    // Not a live region: it's there when the page opens.
    <p className="rounded-xl border border-line bg-sunk px-5 py-3 text-[13.5px] text-ink2">
      {text}
    </p>
  );
}
