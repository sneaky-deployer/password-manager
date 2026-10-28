import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GeneratePasswordDialog } from "./GeneratePasswordDialog.tsx";
import { PasswordGeneratorPanel } from "./PasswordGeneratorPanel.tsx";
import {
  GENERATOR_STORAGE_KEY,
  loadGeneratorSettings,
  sanitizeGeneratorSettings,
} from "./settings.ts";

const output = () => screen.getByTestId("generator-output").textContent ?? "";
const strength = () => screen.getByTestId("generator-strength").textContent ?? "";

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("PasswordGeneratorPanel", () => {
  it("generates a 20 character password by default", () => {
    render(<PasswordGeneratorPanel />);
    expect(output()).toHaveLength(20);
    expect(screen.getByRole("radio", { name: "Password" })).toBeChecked();
    expect(strength()).toMatch(/Very strong/);
    expect(strength()).toMatch(/128\.\d bits/);
  });

  it("regenerates when the button is pressed", async () => {
    const user = userEvent.setup();
    render(<PasswordGeneratorPanel />);
    const first = output();
    await user.click(screen.getByRole("button", { name: "Regenerate" }));
    expect(output()).toHaveLength(20);
    expect(output()).not.toBe(first);
  });

  it("regenerates when options change", async () => {
    const user = userEvent.setup();
    render(<PasswordGeneratorPanel />);
    fireEvent.change(screen.getByLabelText("Length"), { target: { value: "32" } });
    expect(output()).toHaveLength(32);

    fireEvent.change(screen.getByLabelText("Length slider"), { target: { value: "64" } });
    expect(output()).toHaveLength(64);
    expect(screen.getByLabelText("Length")).toHaveValue(64);

    await user.click(screen.getByLabelText("Symbols (!@#$%^&*)"));
    await user.click(screen.getByLabelText("Uppercase letters (A-Z)"));
    await user.click(screen.getByLabelText("Lowercase letters (a-z)"));
    expect(output()).toMatch(/^\d{64}$/);
  });

  it("honours avoid ambiguous characters", async () => {
    const user = userEvent.setup();
    render(<PasswordGeneratorPanel />);
    fireEvent.change(screen.getByLabelText("Length"), { target: { value: "128" } });
    await user.click(screen.getByLabelText(/avoid ambiguous/i));
    expect(output()).not.toMatch(/[0Oo1lI|]/);
  });

  it("shows the generator's message for invalid combinations instead of crashing", async () => {
    const user = userEvent.setup();
    render(<PasswordGeneratorPanel onUse={() => {}} />);
    for (const name of [
      "Lowercase letters (a-z)",
      "Uppercase letters (A-Z)",
      "Digits (0-9)",
      "Symbols (!@#$%^&*)",
    ]) {
      await user.click(screen.getByLabelText(name));
    }
    expect(screen.getByRole("alert")).toHaveTextContent("select at least one character set");
    expect(screen.queryByTestId("generator-output")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use this password" })).toBeDisabled();

    // Recovers once the combination is valid again.
    await user.click(screen.getByLabelText("Digits (0-9)"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(output()).toMatch(/^\d{20}$/);
  });

  it("shows the length error while the number box holds an out-of-range value, and clamps on blur", async () => {
    const user = userEvent.setup();
    render(<PasswordGeneratorPanel />);
    const box = screen.getByLabelText("Length");
    await user.clear(box);
    await user.type(box, "3");
    expect(screen.getByRole("alert")).toHaveTextContent(
      /length must be an integer between 8 and 128/,
    );
    await user.tab();
    expect(box).toHaveValue(8);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(output()).toHaveLength(8);
  });

  it("calls onUse with the generated value", async () => {
    const user = userEvent.setup();
    const onUse = vi.fn();
    render(<PasswordGeneratorPanel onUse={onUse} />);
    await user.click(screen.getByRole("button", { name: "Use this password" }));
    expect(onUse).toHaveBeenCalledTimes(1);
    expect(onUse).toHaveBeenCalledWith(output());
  });

  it("has no use button without onUse", () => {
    render(<PasswordGeneratorPanel />);
    expect(screen.queryByRole("button", { name: /use this password/i })).not.toBeInTheDocument();
  });

  it("updates the entropy label with the options", () => {
    render(<PasswordGeneratorPanel />);
    expect(strength()).toMatch(/Very strong/);
    fireEvent.change(screen.getByLabelText("Length"), { target: { value: "12" } });
    expect(strength()).toMatch(/Fair/);
    fireEvent.change(screen.getByLabelText("Length"), { target: { value: "8" } });
    expect(strength()).toMatch(/Fair|Weak/);
  });

  it("switches to passphrase mode", async () => {
    const user = userEvent.setup();
    render(<PasswordGeneratorPanel />);
    await user.click(screen.getByRole("radio", { name: "Passphrase" }));
    expect(output().split("-")).toHaveLength(5);
    expect(strength()).toMatch(/Fair/);
    expect(strength()).toMatch(/64\.6 bits/);

    fireEvent.change(screen.getByLabelText("Words"), { target: { value: "7" } });
    expect(output().split("-")).toHaveLength(7);
    expect(strength()).toMatch(/Strong/);
    fireEvent.change(screen.getByLabelText("Words"), { target: { value: "8" } });
    expect(strength()).toMatch(/Very strong/);

    await user.selectOptions(screen.getByLabelText("Separator"), "Space");
    expect(output().split(" ")).toHaveLength(8);
    await user.selectOptions(screen.getByLabelText("Separator"), "Random digit");
    expect(output()).toMatch(/^[a-z]+(\d[a-z]+){7}$/);

    await user.click(screen.getByLabelText("Capitalize each word"));
    expect(output()).toMatch(/^[A-Z][a-z]+(\d[A-Z][a-z]+){7}$/);
  });

  it("colours digits, symbols and letters by class", () => {
    render(<PasswordGeneratorPanel />);
    const spans = within(screen.getByTestId("generator-output")).getAllByText(/./);
    expect(spans.map((s) => s.textContent).join("")).toBe(output());
    for (const span of spans) {
      const text = span.textContent ?? "";
      if (/^\d+$/.test(text)) expect(span).toHaveClass("text-sky-700");
      else if (/^[A-Za-z]+$/.test(text)) expect(span).toHaveClass("text-slate-900");
      else expect(span).toHaveClass("text-rose-700");
    }
  });

  it("remembers the last options", async () => {
    const user = userEvent.setup();
    const first = render(<PasswordGeneratorPanel />);
    fireEvent.change(screen.getByLabelText("Length"), { target: { value: "40" } });
    await user.click(screen.getByLabelText("Symbols (!@#$%^&*)"));
    expect(JSON.parse(window.localStorage.getItem(GENERATOR_STORAGE_KEY) ?? "{}")).toMatchObject({
      mode: "password",
      password: { length: 40, symbols: false },
    });
    first.unmount();

    render(<PasswordGeneratorPanel />);
    expect(screen.getByLabelText("Length")).toHaveValue(40);
    expect(screen.getByLabelText("Symbols (!@#$%^&*)")).not.toBeChecked();
    expect(output()).toHaveLength(40);
  });

  it("never stores the generated value", () => {
    render(<PasswordGeneratorPanel />);
    expect(window.localStorage.getItem(GENERATOR_STORAGE_KEY) ?? "").not.toContain(output());
  });

  it("does not remember an invalid combination", async () => {
    const user = userEvent.setup();
    render(<PasswordGeneratorPanel />);
    for (const name of ["Lowercase letters (a-z)", "Uppercase letters (A-Z)", "Digits (0-9)"]) {
      await user.click(screen.getByLabelText(name));
    }
    const saved = window.localStorage.getItem(GENERATOR_STORAGE_KEY);
    expect(saved).toContain('"symbols":true');
    await user.click(screen.getByLabelText("Symbols (!@#$%^&*)"));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(window.localStorage.getItem(GENERATOR_STORAGE_KEY)).toBe(saved);
  });

  it("works when localStorage throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const user = userEvent.setup();
    render(<PasswordGeneratorPanel />);
    expect(output()).toHaveLength(20);
    await user.click(screen.getByLabelText("Digits (0-9)"));
    expect(output()).not.toMatch(/\d/);
  });

  it("ignores corrupt stored settings", () => {
    window.localStorage.setItem(GENERATOR_STORAGE_KEY, "{not json");
    expect(loadGeneratorSettings().password.length).toBe(20);
    expect(
      sanitizeGeneratorSettings({ mode: "x", password: { length: "9", symbols: 3 } }),
    ).toMatchObject({
      mode: "password",
      password: { length: 20, symbols: true },
    });
    window.localStorage.setItem(
      GENERATOR_STORAGE_KEY,
      JSON.stringify({ passphrase: { separator: "??", words: 99 } }),
    );
    render(<PasswordGeneratorPanel />);
    expect(output()).toHaveLength(20);
  });
});

describe("GeneratePasswordDialog", () => {
  it("passes the value to onUse and closes", async () => {
    const user = userEvent.setup();
    const onUse = vi.fn();
    const onClose = vi.fn();
    render(<GeneratePasswordDialog open onClose={onClose} onUse={onUse} />);
    const dialog = screen.getByRole("dialog", { name: "Generate a password" });
    const value = within(dialog).getByTestId("generator-output").textContent;
    await user.click(within(dialog).getByRole("button", { name: "Use this password" }));
    expect(onUse).toHaveBeenCalledWith(value);
    expect(onClose).toHaveBeenCalled();
  });

  it("renders nothing while closed", () => {
    render(<GeneratePasswordDialog open={false} onClose={() => {}} onUse={() => {}} />);
    expect(screen.queryByTestId("generator-output")).not.toBeInTheDocument();
  });
});
