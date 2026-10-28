import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { makeUser } from "../../test/fixtures.ts";
import { mockApi } from "../../test/mock-api.ts";
import { renderApp } from "../../test/render-app.tsx";

describe("/generator route", () => {
  it("renders the full panel inside the app shell and is reachable from the header", async () => {
    mockApi({ "GET /api/me": () => ({ user: makeUser() }) });
    const user = userEvent.setup();
    const { router } = renderApp("/settings/security", { locked: false });

    await user.click(await screen.findByRole("link", { name: "Generator" }));
    expect(await screen.findByRole("heading", { name: "Generator" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/generator");
    expect(screen.getByTestId("generator-output").textContent).toHaveLength(20);
    expect(screen.getByRole("link", { name: "Generator" })).toHaveAttribute("aria-current", "page");
  });
});
