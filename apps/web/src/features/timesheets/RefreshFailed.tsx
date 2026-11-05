// #338: the week's rebuild failed or took too long, so what is shown is what was stored
// before. Says so and offers to try again; it stays in place while retrying so the
// focus stays on the button.
import { Button } from "../../components/ui/button";

export function RefreshFailed({
  onRetry,
  retrying,
  className = "",
}: {
  onRetry: () => void;
  retrying: boolean;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={`flex flex-wrap items-center gap-2 text-[12.5px] text-warnink ${className}`}
    >
      <span>Couldn't refresh the week. These are the last saved numbers.</span>
      <Button
        variant="secondary"
        className="h-8"
        aria-disabled={retrying}
        onClick={() => {
          if (!retrying) onRetry();
        }}
      >
        {retrying ? "Retrying…" : "Retry"}
      </Button>
    </div>
  );
}
