// Captures of one passed check-in (#34, DSH-04): screenshots and the webcam frame
// side by side, with time, active app and project. Every open is audit-logged on
// the server (capture_view); links last 5 minutes.
import { useQuery } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";
import { Time } from "../../lib/time";

interface CaptureView {
  checkin_id: string;
  responded_at: string | null;
  scheduled_at: string;
  project_id: string | null;
  app: string | null;
  domain: string | null;
  expired: boolean;
  capture_errors: { screen?: string; webcam?: string } | null;
  files: { name: string; signed_path: string | null }[];
}

const errorText: Record<string, string> = {
  permission_missing: "permission was missing",
  camera_busy: "the camera was busy",
  no_camera: "there was no camera",
  failed: "capture failed",
};

/** The function returns path + query only; the API's public URL is ours. */
function signedUrl(path: string | null): string | null {
  return path ? new URL(path, import.meta.env.VITE_SUPABASE_URL).toString() : null;
}

function label(name: string): string {
  if (name === "webcam.webp") return "Webcam";
  const display = name.match(/^screen-(\d+)\.webp$/)?.[1];
  return display ? `Screen ${display}` : name;
}

export function CaptureViewer({ checkinId, zone }: { checkinId: string; zone: string }) {
  // Not cached: each open is a new, logged view with fresh links.
  const { data, error, isPending } = useQuery({
    queryKey: ["captures", checkinId],
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

  if (isPending) return <p className="text-sm text-ink2">Loading captures…</p>;
  if (error) {
    return (
      <p role="alert" className="text-sm text-warnink">
        Couldn't open the captures: {error.message}
      </p>
    );
  }

  const screens = data.files.filter((f) => f.name !== "webcam.webp");
  const webcam = data.files.find((f) => f.name === "webcam.webp");
  const missing = Object.entries(data.capture_errors ?? {});

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-ink2">
        <Time iso={data.responded_at ?? data.scheduled_at} employeeZone={zone} />
        {" · "}
        {data.app ? `${data.app}${data.domain ? ` (${data.domain})` : ""}` : "App not recorded"}
        {" · "}
        {data.project_id ? "Project set" : "No project"}
      </p>
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
        <div className="flex flex-col gap-3">
          {screens.length === 0 && <Placeholder text="No screenshot" />}
          {screens.map((f) => (
            <Image
              key={f.name}
              name={f.name}
              url={signedUrl(f.signed_path)}
              expired={data.expired}
            />
          ))}
        </div>
        <div>
          {webcam ? (
            <Image name={webcam.name} url={signedUrl(webcam.signed_path)} expired={data.expired} />
          ) : (
            <Placeholder text="No webcam frame" />
          )}
        </div>
      </div>
      {missing.length > 0 && (
        <p className="text-[13px] text-ink3">
          {missing.map(([kind, why]) => `No ${kind}: ${errorText[why] ?? why}.`).join(" ")}
        </p>
      )}
      <p className="text-xs text-ink3">
        This view is recorded in the audit log and visible to the employee. Links expire in 5
        minutes.
      </p>
    </div>
  );
}

function Image({ name, url, expired }: { name: string; url: string | null; expired: boolean }) {
  if (expired) return <Placeholder text={`${label(name)} deleted after the retention period`} />;
  if (!url) return <Placeholder text={`${label(name)} not uploaded yet`} />;
  return (
    <figure className="flex flex-col gap-1">
      <img
        src={url}
        alt={`${label(name)} at check-in`}
        className="w-full rounded-lg border border-line bg-sunk"
        referrerPolicy="no-referrer"
      />
      <figcaption className="text-xs text-ink3">{label(name)}</figcaption>
    </figure>
  );
}

function Placeholder({ text }: { text: string }) {
  return (
    <div className="grid aspect-video place-items-center rounded-lg border border-dashed border-line2 bg-sunk p-4 text-center text-[13px] text-ink3">
      {text}
    </div>
  );
}
