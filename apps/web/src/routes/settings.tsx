import { createRoute, redirect } from "@tanstack/react-router";
import { ActivityPage } from "../features/settings/ActivityPage.tsx";
import { DangerZonePage } from "../features/settings/DangerZonePage.tsx";
import { PreferencesPage } from "../features/settings/PreferencesPage.tsx";
import { SecurityPage } from "../features/settings/SecurityPage.tsx";
import { SessionsPage } from "../features/settings/SessionsPage.tsx";
import { SettingsLayout } from "../features/settings/SettingsLayout.tsx";
import { appRoute } from "./app.tsx";

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings",
  component: SettingsLayout,
});

const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/settings/security", replace: true });
  },
});

const securityRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/security",
  component: SecurityPage,
});
const sessionsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/sessions",
  component: SessionsPage,
});
const activityRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/activity",
  component: ActivityPage,
});
const preferencesRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/preferences",
  component: PreferencesPage,
});
const dangerRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/danger",
  component: DangerZonePage,
});

export const settingsRoutes = [
  settingsRoute.addChildren([
    settingsIndexRoute,
    securityRoute,
    sessionsRoute,
    activityRoute,
    preferencesRoute,
    dangerRoute,
  ]),
];
