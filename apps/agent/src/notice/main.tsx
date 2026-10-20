import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { OnboardingWindow } from "./OnboardingWindow";
import "./notice.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <OnboardingWindow />
  </StrictMode>,
);
