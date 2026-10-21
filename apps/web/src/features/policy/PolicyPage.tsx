// Monitoring policy (#52, ADM-01, CAP-05, AUD-01): one page for every configurable value
// of PRD section 6, filled from the region preset. Owners and admins only. The database
// validates again, audit-logs the change, and agents pick it up at their next sync.
import type {
  Policy,
  PolicyKey,
  PolicySettings,
  Region,
  UpdatePolicyReply,
} from "@ai-proctor/contracts";
import {
  EU_IMAGE_RETENTION_MAX_DAYS,
  POLICY_LIMITS,
  SCREENSHOT_MODES,
  WEEK_STARTS,
} from "@ai-proctor/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useBlocker, useRouteContext } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/cn";
import { noticesQuery } from "../notice/noticeData";
import { AppList, Check, Group, NumberField, OnOff, Row, Segmented } from "./fields";
import {
  applyPreset,
  canSave,
  capital,
  changedKeys,
  confirmationsNeeded,
  type FieldErrors,
  pick,
  regionLabels,
  validate,
} from "./form";
import { policySettingsQuery, savePolicy } from "./policyData";
import { noticePreview } from "./preview";

export function PolicyPage() {
  const { profile } = useRouteContext({ from: "/_app" });
  const { data, error } = useQuery(policySettingsQuery);
  const [saved, setSaved] = useState<UpdatePolicyReply | null>(null);

  return (
    <section className="flex flex-col gap-5">
      {error ? (
        <p role="alert" className="text-sm text-warnink">
          Couldn't load the policy: {error.message}
        </p>
      ) : !data ? (
        <p className="text-sm text-ink2">Loading…</p>
      ) : (
        <PolicyForm
          // A new saved policy starts a fresh draft.
          key={`${data.policy_version}:${JSON.stringify(data.policy)}`}
          settings={data}
          orgName={profile.orgName}
          saved={saved}
          onSaved={setSaved}
        />
      )}
    </section>
  );
}

const regions = [
  ["us", regionLabels.us],
  ["eu", regionLabels.eu],
  ["india", regionLabels.india],
] as const;

const screenshotOptions = SCREENSHOT_MODES.map((m) => [m, capital(m)] as const);

function PolicyForm({
  settings,
  orgName,
  saved,
  onSaved,
}: {
  settings: PolicySettings;
  orgName: string;
  saved: UpdatePolicyReply | null;
  onSaved: (reply: UpdatePolicyReply | null) => void;
}) {
  const queryClient = useQueryClient();
  const region = settings.region_preset;
  const [draft, setDraft] = useState<Policy>(settings.policy);
  const [preset, setPreset] = useState<Region>(region);
  const [dpia, setDpia] = useState(false);
  const [council, setCouncil] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  const checked = validate(draft, region);
  const errors: FieldErrors = checked.errors ?? {};
  const changed = changedKeys(settings.policy, draft);
  const dirty = changed.length > 0;
  const needed = confirmationsNeeded(settings, draft);
  const ready = canSave({
    valid: checked.data !== null,
    dirty,
    needed,
    confirmed: { dpia, worksCouncil: council },
  });

  useBlocker({
    shouldBlockFn: () => dirty && !window.confirm("Leave without saving your policy changes?"),
    enableBeforeUnload: () => dirty,
  });

  const save = useMutation({
    mutationFn: () => {
      if (!checked.data) throw new Error("Fix the highlighted settings first.");
      return savePolicy(pick(checked.data, changed), {
        dpia: needed.dpia && dpia,
        worksCouncil: needed.worksCouncil && council,
      });
    },
    onSuccess: (reply) => {
      onSaved(reply);
      queryClient.invalidateQueries({ queryKey: policySettingsQuery.queryKey });
      queryClient.invalidateQueries({ queryKey: noticesQuery.queryKey });
      // Whether two-factor is required is read from the policy at sign-in.
      queryClient.invalidateQueries({ queryKey: ["profile"] });
    },
  });

  const set = <K extends PolicyKey>(key: K, value: Policy[K]) => {
    onSaved(null);
    setDraft((d) => ({ ...d, [key]: value }));
    if (key === "webcam") {
      setDpia(false);
      setCouncil(false);
    }
  };
  const err = (key: PolicyKey) => errors[key];
  const euCap = region === "eu";
  const [retentionMin, retentionMax] = POLICY_LIMITS.image_retention_days;

  return (
    <>
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.025em]">Monitoring policy</h1>
          <p className="mt-1 text-[13.5px] text-ink2">
            Applies to everyone in {orgName} ({settings.members}{" "}
            {settings.members === 1 ? "person" : "people"}). Changes reach each person's app at its
            next sync. Anything that collects more asks people to acknowledge a new notice first.
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={!dirty}
            onClick={() => setConfirmingDiscard(true)}
          >
            Discard
          </Button>
          <Button type="button" disabled={!ready || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save policy"}
          </Button>
        </div>
      </div>

      {confirmingDiscard && (
        <div
          role="alertdialog"
          aria-label="Discard changes"
          className="flex flex-wrap items-center gap-3 rounded-xl border border-warnline bg-warnbg p-4 text-[13.5px] text-warnink"
        >
          <span className="font-medium">
            Discard {changed.length} unsaved {changed.length === 1 ? "change" : "changes"}?
          </span>
          <span className="ml-auto flex gap-2">
            <Button type="button" variant="secondary" onClick={() => setConfirmingDiscard(false)}>
              Keep editing
            </Button>
            <Button
              type="button"
              onClick={() => {
                setDraft(settings.policy);
                setPreset(region);
                setDpia(false);
                setCouncil(false);
                setConfirmingDiscard(false);
              }}
            >
              Discard changes
            </Button>
          </span>
        </div>
      )}
      {save.error && (
        <p role="alert" className="text-sm text-warnink">
          Couldn't save: {save.error.message}
        </p>
      )}
      {saved && (
        <p role="status" className="rounded-xl border border-line bg-panel p-4 text-[13.5px]">
          {saved.changed.length === 0
            ? "Saved. Nothing changed."
            : `Saved ${saved.changed.length} ${saved.changed.length === 1 ? "setting" : "settings"}. The change is in the audit log and reaches agents at their next sync.`}
          {saved.notice_version !== null && (
            <>
              {" "}
              Monitoring notice version {saved.notice_version} was published; everyone will be asked
              to acknowledge it. Review its wording under{" "}
              <Link to="/notice" className="underline">
                Monitoring notice
              </Link>
              .
            </>
          )}
        </p>
      )}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="overflow-hidden rounded-xl border border-line bg-panel">
          <Row
            title="Region preset"
            hint="Fills the form with that region's defaults for local privacy law. Nothing changes until you save. Two-factor for admins is left as it is."
          >
            <Segmented
              label="Region preset"
              value={preset}
              options={regions}
              onChange={(r) => {
                onSaved(null);
                setPreset(r);
                setDraft((d) => applyPreset(d, settings.presets[r]));
                setDpia(false);
                setCouncil(false);
              }}
            />
            {euCap && (
              <p className="max-w-xl text-[12.5px] text-ink2">
                This is an EU organisation, so images are kept 30 days at most and turning on the
                webcam needs a confirmed DPIA, whichever preset you fill in.
              </p>
            )}
          </Row>

          <Group title="Check-ins">
            <Row
              title="Check-in interval"
              hint="Each check-in is drawn at random between the shortest and longest. Exact times can't be predicted."
            >
              <div className="flex flex-wrap gap-3">
                <NumberField
                  label="Shortest interval"
                  unit="min"
                  value={draft.checkin_min_interval_min}
                  error={err("checkin_min_interval_min")}
                  onChange={(v) => set("checkin_min_interval_min", v as number)}
                />
                <NumberField
                  label="Longest interval"
                  unit="min"
                  value={draft.checkin_max_interval_min}
                  error={err("checkin_max_interval_min")}
                  onChange={(v) => set("checkin_max_interval_min", v as number)}
                />
              </div>
            </Row>
            <Row
              title="Response window"
              hint="How long a check-in card stays up before it counts as missed."
            >
              <NumberField
                label="Response window"
                unit="s"
                value={draft.checkin_response_s}
                error={err("checkin_response_s")}
                onChange={(v) => set("checkin_response_s", v as number)}
              />
            </Row>
            <Row
              title="Idle threshold"
              hint="Minutes without keyboard or mouse input before someone shows as Idle."
            >
              <NumberField
                label="Idle threshold"
                unit="min"
                value={draft.idle_threshold_min}
                error={err("idle_threshold_min")}
                onChange={(v) => set("idle_threshold_min", v as number)}
              />
            </Row>
          </Group>

          <Group title="Capture">
            <Row
              title="Screenshots"
              hint="Taken only on a passed check-in. Blurred keeps app layout visible but text unreadable."
            >
              <Segmented
                label="Screenshots"
                value={draft.screenshots}
                options={screenshotOptions}
                onChange={(v) => set("screenshots", v)}
              />
            </Row>
            <Row
              title="Webcam frame"
              hint="One still image on a passed check-in. Never video, never audio."
            >
              <OnOff label="Webcam frame" value={draft.webcam} onChange={(v) => set("webcam", v)} />
              {needed.dpia && (
                <div className="flex max-w-xl flex-col gap-1 rounded-[10px] border border-warnline bg-warnbg px-3.5 py-3 text-warnink">
                  <p className="text-[13px] leading-[1.45]">
                    <span className="font-semibold">Required in the EU.</span> Webcam capture needs
                    a completed Data Protection Impact Assessment
                    {needed.worksCouncil
                      ? `, and the works council consulted (${settings.works_council_members} ${settings.works_council_members === 1 ? "person works" : "people work"} in Germany, France or the Netherlands)`
                      : ""}
                    . Your confirmation is recorded in the audit log.
                  </p>
                  <Check
                    label="I confirm a DPIA has been completed"
                    checked={dpia}
                    onChange={setDpia}
                  />
                  {needed.worksCouncil && (
                    <Check
                      label="I confirm the works council has been consulted"
                      checked={council}
                      onChange={setCouncil}
                    />
                  )}
                </div>
              )}
              {region === "eu" && draft.webcam && !needed.dpia && (
                <p className="max-w-xl text-[12.5px] text-ink2">
                  A DPIA was confirmed when the webcam was turned on. It is in the audit log.
                </p>
              )}
            </Row>
            <Row
              title="Window titles"
              hint="The title of the window in front, never for excluded apps. App names and websites are recorded either way."
            >
              <OnOff
                label="Window titles"
                value={draft.window_titles}
                onChange={(v) => set("window_titles", v)}
              />
            </Row>
            <Row
              title="App activity"
              hint="The app in front and the website domain, in one-minute totals while clocked in."
            >
              <OnOff
                label="App activity"
                value={draft.activity_sampling}
                onChange={(v) => set("activity_sampling", v)}
              />
            </Row>
            <Row
              title="Excluded apps"
              hint="When one of these is in front at a check-in, that screen's screenshot is replaced with a placeholder, and its window titles aren't recorded."
            >
              <AppList
                apps={draft.excluded_apps}
                error={err("excluded_apps")}
                onChange={(apps) => set("excluded_apps", apps)}
              />
            </Row>
          </Group>

          <Group title="Retention">
            <Row
              title="Image retention"
              hint={`Screenshots and webcam frames are deleted after this (${retentionMin} to ${retentionMax} days${euCap ? `, ${EU_IMAGE_RETENTION_MAX_DAYS} at most in the EU` : ""}).`}
            >
              <NumberField
                label="Image retention"
                unit="days"
                value={draft.image_retention_days}
                error={err("image_retention_days")}
                onChange={(v) => set("image_retention_days", v as number)}
              />
            </Row>
            <Row
              title="Record retention"
              hint="Check-in and activity events, and shift records with timesheets. The audit log is kept at least 3 years whatever these say."
            >
              <div className="flex flex-wrap gap-3">
                <NumberField
                  label="Check-in and activity events"
                  unit="months"
                  value={draft.event_retention_months}
                  error={err("event_retention_months")}
                  onChange={(v) => set("event_retention_months", v as number)}
                />
                <NumberField
                  label="Timesheets and segments"
                  unit="years"
                  value={draft.timesheet_retention_years}
                  error={err("timesheet_retention_years")}
                  onChange={(v) => set("timesheet_retention_years", v as number)}
                />
              </div>
            </Row>
          </Group>

          <Group title="Breaks and pauses">
            <Row
              title="Breaks"
              hint="Paid breaks count as worked time. A daily limit flags the excess; it never stops a break."
            >
              <Segmented
                label="Breaks"
                value={draft.breaks_paid ? "paid" : "unpaid"}
                options={
                  [
                    ["unpaid", "Unpaid"],
                    ["paid", "Paid"],
                  ] as const
                }
                onChange={(v) => set("breaks_paid", v === "paid")}
              />
              <div>
                <NumberField
                  label="Daily break limit"
                  unit="min"
                  optional
                  placeholder="No limit"
                  value={draft.break_daily_max_min}
                  error={err("break_daily_max_min")}
                  onChange={(v) => set("break_daily_max_min", v)}
                />
              </div>
            </Row>
            <Row
              title="Pause limits"
              hint="Pauses stop all collection. Time up to the limits counts as worked; the excess is flagged."
            >
              <div className="flex flex-wrap gap-3">
                <NumberField
                  label="Each pause"
                  unit="min"
                  value={draft.pause_max_min}
                  error={err("pause_max_min")}
                  onChange={(v) => set("pause_max_min", v as number)}
                />
                <NumberField
                  label="Per day"
                  unit="min"
                  value={draft.pause_daily_max_min}
                  error={err("pause_daily_max_min")}
                  onChange={(v) => set("pause_daily_max_min", v as number)}
                />
              </div>
            </Row>
          </Group>

          <Group title="Shifts and timesheets">
            <Row
              title="Auto clock-in"
              hint="Clock people in on their first input inside their shift."
            >
              <OnOff
                label="Auto clock-in"
                value={draft.auto_clock_in}
                onChange={(v) => set("auto_clock_in", v)}
              />
            </Row>
            <Row
              title="Forgotten clock-out"
              hint="Minutes without input after a shift ends before someone is clocked out automatically."
            >
              <NumberField
                label="Clock out after"
                unit="min"
                value={draft.forgotten_clock_out_min}
                error={err("forgotten_clock_out_min")}
                onChange={(v) => set("forgotten_clock_out_min", v as number)}
              />
            </Row>
            <Row title="Week start" hint="The first day of the week on timesheets and reports.">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="week-start" className="text-[12.5px] text-ink2">
                  Week starts on
                </label>
                <select
                  id="week-start"
                  value={draft.week_start}
                  onChange={(e) => set("week_start", e.target.value as Policy["week_start"])}
                  className="h-11 w-40 rounded-[9px] border border-line2 bg-panel px-3 text-sm capitalize text-ink"
                >
                  {WEEK_STARTS.map((d) => (
                    <option key={d} value={d}>
                      {capital(d)}
                    </option>
                  ))}
                </select>
              </div>
            </Row>
            <Row
              title="Late clock-in grace"
              hint="Minutes after a shift starts before a missing clock-in counts as late. Alerts and reports use the same value."
            >
              <NumberField
                label="Late clock-in grace"
                unit="min"
                value={draft.late_clock_in_min}
                error={err("late_clock_in_min")}
                onChange={(v) => set("late_clock_in_min", v as number)}
              />
            </Row>
            <Row
              title="Overtime thresholds"
              hint="Worked time above these is highlighted on timesheets and in XLSX exports. Nothing is paid or deducted. Leave a box empty to switch it off."
            >
              <div className="flex flex-wrap gap-3">
                <NumberField
                  label="Daily threshold"
                  unit="h"
                  step={0.25}
                  optional
                  placeholder="Off"
                  value={draft.overtime_daily_hours}
                  error={err("overtime_daily_hours")}
                  onChange={(v) => set("overtime_daily_hours", v)}
                />
                <NumberField
                  label="Weekly threshold"
                  unit="h"
                  step={0.25}
                  optional
                  placeholder="Off"
                  value={draft.overtime_weekly_hours}
                  error={err("overtime_weekly_hours")}
                  onChange={(v) => set("overtime_weekly_hours", v)}
                />
              </div>
            </Row>
            <Row
              title="Timesheet reminders"
              hint="Remind people to submit on their last shift day of the week (the last day of the week if they have no shifts), and remind managers, then admins, when a week waits for approval."
            >
              <OnOff
                label="Timesheet reminders"
                value={draft.reminders_enabled}
                onChange={(v) => set("reminders_enabled", v)}
              />
            </Row>
          </Group>

          <Group title="Manager alerts">
            <Row
              title="Alert types"
              hint="Managers get these in the app and by email, at most one email per person and type an hour."
            >
              <div className="flex flex-col">
                <Check
                  label="Consecutive missed check-ins"
                  checked={draft.alert_consecutive_misses_enabled}
                  onChange={(v) => set("alert_consecutive_misses_enabled", v)}
                />
                <Check
                  label="Offline during a shift"
                  checked={draft.alert_offline_enabled}
                  onChange={(v) => set("alert_offline_enabled", v)}
                />
                <Check
                  label="Tamper"
                  checked={draft.alert_tamper_enabled}
                  onChange={(v) => set("alert_tamper_enabled", v)}
                />
                <Check
                  label="Late clock-in"
                  checked={draft.alert_late_clock_in_enabled}
                  onChange={(v) => set("alert_late_clock_in_enabled", v)}
                />
                <Check
                  label="Pause over the daily limit"
                  checked={draft.alert_pause_over_cap_enabled}
                  onChange={(v) => set("alert_pause_over_cap_enabled", v)}
                />
              </div>
            </Row>
            <Row
              title="Alert thresholds"
              hint="How many misses in a row, and how long offline during a shift, before an alert."
            >
              <div className="flex flex-wrap gap-3">
                <NumberField
                  label="Misses in a row"
                  unit="misses"
                  value={draft.alert_consecutive_misses}
                  error={err("alert_consecutive_misses")}
                  onChange={(v) => set("alert_consecutive_misses", v as number)}
                />
                <NumberField
                  label="Offline for"
                  unit="min"
                  value={draft.alert_offline_min}
                  error={err("alert_offline_min")}
                  onChange={(v) => set("alert_offline_min", v as number)}
                />
              </div>
            </Row>
          </Group>

          <Group title="Review flags">
            <Row
              title="Response-time review"
              hint="Days with implausibly consistent response times are flagged as needs review, never as a penalty."
            >
              <div className="flex flex-wrap gap-3">
                <NumberField
                  label="Passes needed in a day"
                  unit="passes"
                  value={draft.anticheat_min_passes}
                  error={err("anticheat_min_passes")}
                  onChange={(v) => set("anticheat_min_passes", v as number)}
                />
                <NumberField
                  label="Variation limit"
                  unit="CV"
                  step={0.01}
                  value={draft.anticheat_max_cv}
                  error={err("anticheat_max_cv")}
                  onChange={(v) => set("anticheat_max_cv", v as number)}
                />
              </div>
            </Row>
          </Group>

          <Group title="Security">
            <Row
              title="Admin two-factor"
              hint="Owners and admins see organisation-wide data only with a verified session. Set up your own two-factor first, from the account menu."
            >
              <Check
                label="Require two-factor for owners and admins"
                checked={draft.require_admin_mfa}
                onChange={(v) => set("require_admin_mfa", v)}
              />
            </Row>
          </Group>
        </div>

        <aside
          aria-labelledby="preview-title"
          className={cn(
            "flex flex-col gap-3 rounded-xl border border-line bg-panel p-[18px]",
            "lg:sticky lg:top-4",
          )}
        >
          <div>
            <h2 id="preview-title" className="text-[15px] font-semibold">
              What employees see
            </h2>
            <p className="mt-[3px] text-[12.5px] text-ink2">
              Their monitoring notice updates with this policy.
            </p>
          </div>
          <dl className="flex flex-col gap-3">
            {noticePreview(draft).map((row) => (
              <div key={row.label} className="flex flex-col gap-0.5 border-t border-line pt-2.5">
                <dt className="text-xs font-medium text-ink3">{row.label}</dt>
                <dd className="text-[13px] leading-[1.45]">{row.text}</dd>
              </div>
            ))}
          </dl>
        </aside>
      </div>
    </>
  );
}
