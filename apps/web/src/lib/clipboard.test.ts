import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLIPBOARD_CLEAR_MS, copyWithAutoClear } from "./clipboard.ts";

let clipboard: string;
let hasFocus: boolean;
let permission: "granted" | "prompt";

beforeEach(() => {
  vi.useFakeTimers();
  clipboard = "";
  hasFocus = true;
  permission = "prompt";
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn(async (text: string) => {
        if (!hasFocus && text === "") throw new DOMException("not focused", "NotAllowedError");
        clipboard = text;
      }),
      readText: vi.fn(async () => clipboard),
    },
  });
  Object.defineProperty(navigator, "permissions", {
    configurable: true,
    value: { query: vi.fn(async () => ({ state: permission })) },
  });
  vi.spyOn(document, "hasFocus").mockImplementation(() => hasFocus);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("copyWithAutoClear", () => {
  it("clears the clipboard after 30 seconds", async () => {
    await copyWithAutoClear("s3cret");
    expect(clipboard).toBe("s3cret");
    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS - 1);
    expect(clipboard).toBe("s3cret");
    await vi.advanceTimersByTimeAsync(1);
    expect(clipboard).toBe("");
  });

  it("leaves the clipboard alone when it holds something else and we may read it", async () => {
    permission = "granted";
    await copyWithAutoClear("s3cret");
    clipboard = "something the user copied elsewhere";
    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS);
    expect(clipboard).toBe("something the user copied elsewhere");
  });

  it("a newer copy restarts the timer", async () => {
    await copyWithAutoClear("first");
    await vi.advanceTimersByTimeAsync(20_000);
    await copyWithAutoClear("second");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(clipboard).toBe("second");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(clipboard).toBe("");
  });

  it("waits for focus when the page is in the background", async () => {
    await copyWithAutoClear("s3cret");
    hasFocus = false;
    await vi.advanceTimersByTimeAsync(CLIPBOARD_CLEAR_MS);
    expect(clipboard).toBe("s3cret");
    hasFocus = true;
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(clipboard).toBe("");
  });
});
