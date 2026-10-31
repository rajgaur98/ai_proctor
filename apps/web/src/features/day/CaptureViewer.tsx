// Captures of one passed check-in (#34, #124, DSH-04): the screenshot and the webcam
// frame side by side, with a display switcher when several screens were captured.
// Every open is audit-logged on the server (capture_view), so nothing loads until the
// viewer asks for it ("View captures"); links last 5 minutes. A part the employee removed
// (#253) shows who removed it and when instead of an image.
import { useQuery } from "@tanstack/react-query";
import { type CSSProperties, type ReactNode, useState } from "react";
import { Button } from "../../components/ui/button";
import { supabase } from "../../lib/supabase";
import { Time, viewerZone } from "../../lib/time";
import { noneRemoved, partRemovedText, type RemovedParts } from "./removedText";

export interface CaptureView {
  checkin_id: string;
  responded_at: string | null;
  scheduled_at: string;
  project_id: string | null;
  app: string | null;
  domain: string | null;
  expired: boolean;
  capture_errors: { screen?: string; webcam?: string } | null;
  /** When the employee removed each part (#253); its files are not listed. */
  removed?: RemovedParts;
  files: { name: string; signed_path: string | null }[];
}

const errorText: Record<string, string> = {
  permission_missing: "Permission was missing.",
  camera_busy: "The camera was busy.",
  no_camera: "There was no camera.",
  failed: "Capture failed.",
};

/** The function returns path + query only; the API's public URL is ours. */
function signedUrl(path: string | null): string | null {
  return path ? new URL(path, import.meta.env.VITE_SUPABASE_URL).toString() : null;
}

const webcamName = "webcam.webp";

/** "Display 1" for screen-1.webp, "Webcam" for the frame. */
export function captureLabel(name: string): string {
  if (name === webcamName) return "Webcam";
  const display = name.match(/^screen-(\d+)\.webp$/)?.[1];
  return display ? `Display ${display}` : name;
}

/** The screen files among a check-in's stored names, in display order. */
export function screenFiles<T extends { name: string }>(files: T[]): T[] {
  return files.filter((f) => f.name !== webcamName).sort((a, b) => a.name.localeCompare(b.name));
}

/** Opens the captures. Not cached: each open is a new, logged view with fresh links. */
export function useCaptureView(checkinId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["captures", checkinId],
    enabled,
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<CaptureView> => {
      const { data, error } = await supabase.functions.invoke("capture-url", {
        body: { checkin_id: checkinId },
      });
      if (error) throw error;
      return data as CaptureView;
    },
  });
}

/** Design's Display 1 / Display 2 switch. */
export function DisplaySwitch({
  names,
  value,
  onChange,
}: {
  names: string[];
  value: number;
  onChange: (i: number) => void;
}) {
  return (
    <fieldset className="ml-auto flex min-w-0 overflow-hidden rounded-lg border border-line2 text-[12.5px] font-medium">
      <legend className="sr-only">Display</legend>
      {names.map((n, i) => (
        <button
          key={n}
          type="button"
          aria-pressed={i === value}
          onClick={() => onChange(i)}
          className={`min-h-8 px-3 ${i > 0 ? "border-l border-line2" : ""} ${i === value ? "bg-sunk text-ink" : "text-ink2"}`}
        >
          {captureLabel(n)}
        </button>
      ))}
    </fieldset>
  );
}

const stripes: CSSProperties = {
  background: "repeating-linear-gradient(135deg, var(--sunk) 0 7px, var(--panel) 7px 14px)",
};

function Slot({
  aspect,
  dashed,
  children,
}: {
  aspect: string;
  dashed?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`flex flex-col justify-center gap-1 rounded-lg p-3.5 text-[12.5px] leading-snug text-ink2 ${aspect} ${dashed ? "border-[1.5px] border-dashed border-line2" : "border border-line"}`}
      style={dashed ? undefined : stripes}
    >
      {children}
    </div>
  );
}

function Image({ name, url, expired }: { name: string; url: string | null; expired: boolean }) {
  if (expired) {
    return (
      <Slot aspect="aspect-[16/10]" dashed>
        {captureLabel(name)} deleted after the retention period
      </Slot>
    );
  }
  if (!url) {
    return (
      <Slot aspect="aspect-[16/10]" dashed>
        {captureLabel(name)} not uploaded yet
      </Slot>
    );
  }
  return (
    <figure className="flex flex-col gap-1">
      <img
        src={url}
        alt={`${captureLabel(name)} at check-in`}
        className="w-full rounded-lg border border-line bg-sunk"
        referrerPolicy="no-referrer"
      />
      <figcaption className="text-xs text-ink3">{captureLabel(name)}</figcaption>
    </figure>
  );
}

/**
 * The screenshot and webcam slots of a passed check-in. `keys` are the stored file
 * names, known without opening anything; the files themselves only load once `opened`.
 */
export function CaptureImages({
  keys,
  opened,
  onOpen,
  view,
  display,
  removed = noneRemoved,
  removedBy = "the employee",
}: {
  keys: string[];
  opened: boolean;
  onOpen: () => void;
  view: ReturnType<typeof useCaptureView>;
  display: number;
  /** Parts the employee removed (#253). */
  removed?: RemovedParts;
  /** Who removed them: the employee's name, or "you". */
  removedBy?: string;
}) {
  const zone = viewerZone();
  const screenGone = removed.screen !== null;
  const webcamGone = removed.webcam !== null;
  const hadScreen = screenFiles(keys.map((name) => ({ name }))).length > 0;
  const hadWebcam = keys.includes(webcamName);
  const hasScreen = hadScreen && !screenGone;
  const hasWebcam = hadWebcam && !webcamGone;
  const screenRemoved = (
    <Slot aspect="aspect-[16/10]" dashed>
      <span className="font-semibold text-ink">
        {partRemovedText(
          screenFiles(keys.map((name) => ({ name }))).length > 1
            ? "Screen captures"
            : "Screen capture",
          removed.screen ?? "",
          removedBy,
          zone,
        )}
      </span>
      <span>The check-in still counts as passed.</span>
    </Slot>
  );
  const webcamRemoved = (
    <Slot aspect="aspect-[4/3]" dashed>
      <span className="font-semibold text-ink">
        {partRemovedText("Webcam frame", removed.webcam ?? "", removedBy, zone)}
      </span>
    </Slot>
  );
  const openButton = (
    <Button variant="secondary" className="self-start" onClick={onOpen}>
      View captures
    </Button>
  );

  if (opened && view.isPending) return <p className="text-sm text-ink2">Loading captures…</p>;
  if (opened && view.error) {
    return (
      <p role="alert" className="text-sm text-warnink">
        Couldn't open the captures: {view.error.message}
      </p>
    );
  }

  if (!opened || !view.data) {
    return (
      <div className="grid items-start gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-3">
          {hasScreen ? (
            <Slot aspect="aspect-[16/10]">
              <span>Screenshot and webcam frame are not loaded until you open them.</span>
              {openButton}
            </Slot>
          ) : hadScreen ? (
            screenRemoved
          ) : (
            <Slot aspect="aspect-[16/10]" dashed>
              <span className="font-semibold text-ink">No screenshot</span>
              {!hadWebcam && <span>No captures were stored for this check-in.</span>}
            </Slot>
          )}
        </div>
        {hasWebcam ? (
          <Slot aspect="aspect-[4/3]">
            <span className="font-mono text-[11px] text-ink3">webcam frame</span>
            {/* The screen slot holds the button while there is a screenshot to open. */}
            {!hasScreen && openButton}
          </Slot>
        ) : hadWebcam && webcamGone ? (
          webcamRemoved
        ) : (
          <Slot aspect="aspect-[4/3]" dashed>
            <span className="font-semibold text-ink">No webcam frame</span>
          </Slot>
        )}
      </div>
    );
  }

  const data = view.data;
  const screens = screenFiles(data.files);
  const screen = screens[display] ?? screens[0];
  const webcam = data.files.find((f) => f.name === webcamName);
  const errors = data.capture_errors ?? {};

  return (
    <div className="grid items-start gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      {screen ? (
        <Image name={screen.name} url={signedUrl(screen.signed_path)} expired={data.expired} />
      ) : hadScreen && screenGone ? (
        screenRemoved
      ) : (
        <Slot aspect="aspect-[16/10]" dashed>
          <span className="font-semibold text-ink">No screenshot</span>
          {errors.screen && <span>{errorText[errors.screen] ?? errors.screen}</span>}
        </Slot>
      )}
      {webcam ? (
        <Image name={webcam.name} url={signedUrl(webcam.signed_path)} expired={data.expired} />
      ) : hadWebcam && webcamGone ? (
        webcamRemoved
      ) : (
        <Slot aspect="aspect-[4/3]" dashed>
          <span className="font-semibold text-ink">No webcam frame</span>
          <span>
            {errors.webcam ? `${errorText[errors.webcam] ?? errors.webcam} ` : ""}
            {screen ? "The screenshot was still taken." : ""}
          </span>
        </Slot>
      )}
    </div>
  );
}

/**
 * A whole capture view in one piece, for pages that open it from their own button (My
 * data): it loads on mount, so it is only rendered once the person asked, and says
 * what was recorded about the view.
 */
export function CaptureViewer({
  checkinId,
  zone,
  keys,
  removed,
}: {
  checkinId: string;
  zone: string;
  /** The check-in's stored file names, removed ones included (the view lists only what is left). */
  keys?: string[];
  /** Parts the person removed (#253); this page is their own, so "you" removed them. */
  removed?: RemovedParts;
}) {
  const view = useCaptureView(checkinId, true);
  const [display, setDisplay] = useState(0);
  const data = view.data;
  const screens = data ? screenFiles(data.files) : [];

  return (
    <div className="flex flex-col gap-3">
      {data && (
        <p className="flex flex-wrap items-center gap-x-1 text-[13px] text-ink2">
          <Time iso={data.responded_at ?? data.scheduled_at} employeeZone={zone} />
          {" · "}
          {data.app ? `${data.app}${data.domain ? ` (${data.domain})` : ""}` : "App not recorded"}
          {" · "}
          {data.project_id ? "Project set" : "No project"}
          {screens.length > 1 && (
            <DisplaySwitch
              names={screens.map((s) => s.name)}
              value={display}
              onChange={setDisplay}
            />
          )}
        </p>
      )}
      <CaptureImages
        keys={keys ?? data?.files.map((f) => f.name) ?? []}
        opened
        onOpen={() => {}}
        view={view}
        display={display}
        removed={removed ?? data?.removed ?? noneRemoved}
        removedBy="you"
      />
      <p className="text-xs text-ink3">
        This view is recorded in the audit log and visible to the employee. Links expire in 5
        minutes.
      </p>
    </div>
  );
}
