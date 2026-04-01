import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "@/App.tsx";

import "./index.css";

// Apply product theme from build-time env var.
// Default (nutsd) uses moneyd gold accent.
// dnuts variant uses a different accent via VITE_PRODUCT_THEME=dnuts.
const productTheme = import.meta.env.VITE_PRODUCT_THEME;
if (productTheme) {
  document.documentElement.setAttribute("data-product", productTheme);
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
