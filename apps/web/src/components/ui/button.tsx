// shadcn/ui-style button with the design's variants; 44 px minimum height.
// Disabled and enabled switch at once, with no fade: a button fading in after its data
// loads has half its contrast for a moment, and axe flagged that whenever it ran mid-fade
// (#285).
import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

const buttonVariants = cva(
  "inline-flex h-11 items-center justify-center gap-2 rounded-[9px] px-4 text-sm font-medium disabled:opacity-45 disabled:pointer-events-none",
  {
    variants: {
      variant: {
        primary: "bg-acc text-accink font-semibold px-[18px]",
        secondary: "border border-line2 bg-panel text-ink",
        ghost: "bg-transparent text-ink2",
      },
    },
    defaultVariants: { variant: "primary" },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant }), className)} {...props} />;
}
