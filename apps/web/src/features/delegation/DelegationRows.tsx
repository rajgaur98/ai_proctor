// The rows of a delegation list (#44, #147): who approves for whom, the dates and where
// each stands (upcoming, active, completed or ended early). `subjectName` is the person the
// list is about, or null when it is the viewer's own ("you"). Only the subject's own
// upcoming or active delegations can be ended from here.
import { Button } from "../../components/ui/button";
import type { Delegation } from "./delegationData";
import { rangeLabel, statusLabel } from "./range";

export function DelegationRows({
  rows,
  subjectId,
  subjectName,
  onEnd,
  ending,
}: {
  rows: Delegation[];
  subjectId: string;
  subjectName: string | null;
  onEnd?: (id: string) => void;
  ending?: boolean;
}) {
  return (
    <ul>
      {rows.map((d) => {
        const given = d.managerId === subjectId;
        const live = d.status === "upcoming" || d.status === "active";
        return (
          <li
            key={d.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-5 py-3 text-[13.5px] last:border-0"
          >
            {given ? (
              <span>
                <span className="font-medium">{d.delegateName}</span> approves for{" "}
                {subjectName ?? "you"}
              </span>
            ) : (
              <span>
                {subjectName ?? "You"} approve{subjectName ? "s" : ""} for{" "}
                <span className="font-medium">{d.managerName}</span>
              </span>
            )}
            <span className="text-ink2">{rangeLabel(d.startsOn, d.endsOn)}</span>
            <span className="text-ink3">{statusLabel(d)}</span>
            {given && live && onEnd && (
              <Button
                variant="secondary"
                className="ml-auto h-9"
                aria-label={`End delegation to ${d.delegateName}`}
                disabled={ending}
                onClick={() => onEnd(d.id)}
              >
                End
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
