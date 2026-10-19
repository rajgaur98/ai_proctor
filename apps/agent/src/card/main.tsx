import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CheckInCard } from "./CheckInCard";
import "./card.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <CheckInCard />
  </StrictMode>,
);
