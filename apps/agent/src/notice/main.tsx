import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { NoticeWindow } from "./NoticeWindow";
import "./notice.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <NoticeWindow />
  </StrictMode>,
);
