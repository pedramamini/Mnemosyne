import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AppearanceProvider } from "@/appearance/AppearanceProvider";
import { SessionProvider } from "@/auth/SessionProvider";
import { ToastProvider } from "@/components/ui";
import { App } from "./App";
import "./styles/global.css";

const container = document.getElementById("root");
if (!container) throw new Error('Root element "#root" not found');

createRoot(container).render(
  <StrictMode>
    <AppearanceProvider>
      <BrowserRouter>
        <SessionProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </SessionProvider>
      </BrowserRouter>
    </AppearanceProvider>
  </StrictMode>,
);
