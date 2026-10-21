// Row, segmented control and field pieces of the policy page, in the row style of the
// Claude Design Policy screen (docs/design/screens/Policy.dc.html).
import { EXCLUDED_APP_MAX_LENGTH } from "@ai-proctor/contracts";
import { type ReactNode, useId, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { cn } from "../../lib/cn";

/** A named block of rows. */
export function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="border-b border-line bg-sunk px-[22px] py-2.5 text-xs font-semibold tracking-wide text-ink3 uppercase">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** Title and hint on the left, the controls on the right. */
export function Row({
  title,
  hint,
  children,
}: {
  title: string;
  hint: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="grid gap-x-6 gap-y-3 border-b border-line px-[22px] py-5 md:grid-cols-[minmax(200px,300px)_minmax(0,1fr)]">
      <div>
        <h3 id={id} className="text-sm font-semibold">
          {title}
        </h3>
        <p className="mt-[3px] text-[12.5px] leading-[1.45] text-ink2">{hint}</p>
      </div>
      <fieldset aria-labelledby={id} className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
        {children}
      </fieldset>
    </div>
  );
}

/** Radio buttons drawn as the design's segmented control. A click always fires, so choosing the selected preset again applies it again. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  describedBy,
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (value: T) => void;
  /** Shown but not changeable, as the button's disabled style; say why in `describedBy`. */
  disabled?: boolean | undefined;
  describedBy?: string | undefined;
}) {
  const name = useId();
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      aria-describedby={describedBy}
      className={cn(
        "flex w-max max-w-full overflow-hidden rounded-[9px] border border-line2",
        disabled && "opacity-45",
      )}
    >
      {options.map(([v, text]) => (
        <label
          key={v}
          className={cn(
            "flex h-11 items-center border-l border-line2 px-[18px] text-[13.5px] font-medium first:border-l-0",
            disabled ? "cursor-not-allowed" : "cursor-pointer",
            "has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-acc",
            value === v ? "bg-ink text-panel" : "bg-panel text-ink",
          )}
        >
          <input
            type="radio"
            name={name}
            value={v}
            checked={value === v}
            disabled={disabled}
            onChange={() => {}}
            onClick={() => {
              if (!disabled) onChange(v);
            }}
            className="sr-only"
          />
          {text}
        </label>
      ))}
    </div>
  );
}

export function OnOff({
  label,
  value,
  onChange,
  disabled,
  describedBy,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean | undefined;
  describedBy?: string | undefined;
}) {
  return (
    <Segmented
      label={label}
      value={value ? "on" : "off"}
      disabled={disabled}
      describedBy={describedBy}
      options={
        [
          ["on", "On"],
          ["off", "Off"],
        ] as const
      }
      onChange={(v) => onChange(v === "on")}
    />
  );
}

/**
 * A number with its unit. The value is NaN while the box is blank (or null when `optional`),
 * which the schema reports as an error, so the page never saves it.
 */
export function NumberField({
  label,
  unit,
  value,
  onChange,
  error,
  step = 1,
  optional = false,
  placeholder,
}: {
  label: string;
  unit: string;
  value: number | null;
  onChange: (value: number | null) => void;
  error?: string | undefined;
  step?: number;
  optional?: boolean;
  placeholder?: string;
}) {
  const id = useId();
  const shown = value === null || Number.isNaN(value) ? "" : String(value);
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[12.5px] text-ink2">
        {label}
      </label>
      <div
        className={cn(
          "flex h-11 w-40 items-center gap-1.5 rounded-[9px] border bg-panel px-3 text-sm focus-within:outline-2 focus-within:outline-acc",
          error ? "border-warnink" : "border-line2",
        )}
      >
        <input
          id={id}
          type="number"
          inputMode={step === 1 ? "numeric" : "decimal"}
          step={step}
          value={shown}
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(e) =>
            onChange(
              e.target.value === "" ? (optional ? null : Number.NaN) : Number(e.target.value),
            )
          }
          className="w-full min-w-0 bg-transparent font-mono text-sm text-ink outline-none placeholder:font-sans placeholder:text-ink3"
        />
        <span className="flex-none text-ink3">{unit}</span>
      </div>
      {error && (
        <p id={`${id}-error`} className="max-w-64 text-xs text-warnink">
          {error}
        </p>
      )}
    </div>
  );
}

export function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-3 text-[13.5px] font-medium">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-5 w-5 flex-none accent-acc"
      />
      {label}
    </label>
  );
}

/** The excluded apps (CAP-04): names as the operating system shows them, matched ignoring case. */
export function AppList({
  apps,
  onChange,
  error,
}: {
  apps: string[];
  onChange: (apps: string[]) => void;
  error?: string | undefined;
}) {
  const [text, setText] = useState("");
  const id = useId();
  const add = () => {
    const name = text.trim();
    if (!name) return;
    if (!apps.some((a) => a.toLowerCase() === name.toLowerCase())) onChange([...apps, name]);
    setText("");
  };
  return (
    <div className="flex max-w-xl flex-col gap-3">
      {apps.length === 0 ? (
        <p className="text-[13px] text-ink2">No apps are excluded.</p>
      ) : (
        <ul aria-label="Excluded apps" className="flex flex-wrap gap-2">
          {apps.map((app) => (
            <li
              key={app}
              className="flex h-9 items-center gap-1 rounded-full border border-line2 bg-sunk pr-1 pl-3 text-[13px]"
            >
              {app}
              <button
                type="button"
                aria-label={`Remove ${app}`}
                onClick={() => onChange(apps.filter((a) => a !== app))}
                className="grid h-7 w-7 place-items-center rounded-full text-ink2 hover:bg-line"
              >
                <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-end gap-2">
        <div className="flex flex-1 flex-col gap-1.5">
          <label htmlFor={id} className="text-[12.5px] text-ink2">
            Add an app
          </label>
          <Input
            id={id}
            value={text}
            maxLength={EXCLUDED_APP_MAX_LENGTH}
            placeholder="App name, e.g. Signal"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
        </div>
        <Button type="button" variant="secondary" onClick={add} disabled={!text.trim()}>
          Add
        </Button>
      </div>
      {error && <p className="text-xs text-warnink">{error}</p>}
    </div>
  );
}
