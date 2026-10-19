import type { InputHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-11 w-full rounded-[9px] border border-line2 bg-panel px-3 text-sm text-ink placeholder:text-ink3",
        className,
      )}
      {...props}
    />
  );
}
