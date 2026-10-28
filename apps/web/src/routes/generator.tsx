import { createRoute } from "@tanstack/react-router";
import { GeneratorPage } from "../features/generator/GeneratorPage.tsx";
import { appRoute } from "./app.tsx";

/** Standalone password generator, inside the app shell (signed in and unlocked). */
export const generatorRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/generator",
  component: GeneratorPage,
});
