import * as Sentry from "@sentry/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { supabase } from "./lib/supabase";
import { queryClient, router } from "./router";
import "./styles.css";

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.MODE,
    // No session replay or PII integrations: monitoring data never goes to Sentry.
  });
}

// Sign-out or a revoked session anywhere sends every tab back to sign-in.
supabase.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_OUT" || event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
    queryClient.invalidateQueries();
    if (event === "SIGNED_OUT") router.navigate({ to: "/sign-in" });
  }
});

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
