import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { createQueryClient } from "./lib/query-client.ts";
import { applyTheme, readStoredTheme } from "./lib/theme.ts";
import { wireApp } from "./lib/wiring.ts";
import { createAppRouter } from "./routes/router.ts";

applyTheme(readStoredTheme());

const queryClient = createQueryClient();
const router = createAppRouter({ queryClient });
wireApp(queryClient, () => router.navigate({ to: "/login", replace: true }));

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
