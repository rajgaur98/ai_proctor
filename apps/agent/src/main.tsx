import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Popover } from "./Popover";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <Popover />
  </StrictMode>,
);
