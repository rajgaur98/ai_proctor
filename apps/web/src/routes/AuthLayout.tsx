import type { ReactNode } from "react";

/** Centred card for sign-in, sign-up, onboarding and MFA. */
export function AuthLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-bg p-4">
      <div className="flex w-full max-w-sm flex-col gap-6 rounded-2xl border border-line bg-panel p-6 md:p-8">
        <h1 className="text-2xl font-semibold tracking-[-0.025em]">{title}</h1>
        {children}
      </div>
    </main>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="rounded-lg border border-warnline bg-warnbg px-3 py-2 text-[13px] text-warnink"
    >
      {message}
    </p>
  );
}
