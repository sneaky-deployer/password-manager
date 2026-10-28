import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TotpBadge } from "./TotpBadge.tsx";
import { TotpCode } from "./TotpCode.tsx";
import { RFC_URI, stubDocumentHidden } from "./test-helpers.ts";
import { useTotp } from "./useTotp.ts";

const WEAK_URI = "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP";

function setTime(seconds: number) {
  vi.setSystemTime(new Date(seconds * 1000));
}
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useTotp", () => {
  it("returns the RFC 6238 SHA1 vector at T=59 (8 digits)", () => {
    setTime(59);
    const { result } = renderHook(() => useTotp(RFC_URI));
    expect(result.current).toMatchObject({
      status: "ok",
      code: "94287082",
      formatted: "9428 7082",
      period: 30,
      secondsRemaining: 1,
      expiringSoon: true,
      issuer: "Example",
      label: "alice@example.com",
      weakSecret: false,
    });
  });

  it("reports mid-period state", () => {
    setTime(1111111111);
    const { result } = renderHook(() => useTotp(RFC_URI));
    expect(result.current).toMatchObject({
      status: "ok",
      code: "14050471",
      secondsRemaining: 29,
      expiringSoon: false,
    });
    if (result.current.status === "ok") expect(result.current.progress).toBeCloseTo(1 / 30, 3);
  });

  it("changes the code exactly at the period boundary", () => {
    setTime(29);
    const { result } = renderHook(() => useTotp(RFC_URI));
    const code = () => (result.current.status === "ok" ? result.current.code : null);
    expect(code()).toBe("84755224");
    advance(999);
    expect(code()).toBe("84755224");
    advance(1);
    expect(code()).toBe("94287082");
    // The new period starts with a full ring and the full number of seconds.
    expect(result.current).toMatchObject({ secondsRemaining: 30, expiringSoon: false });
  });

  it("uses clockTracker.now() as the default time source", async () => {
    const { clockTracker } = await import("../../lib/api.ts");
    const now = vi.spyOn(clockTracker, "now").mockReturnValue(59_000);
    const { result } = renderHook(() => useTotp(RFC_URI));
    expect(result.current).toMatchObject({ status: "ok", code: "94287082" });
    now.mockRestore();
  });

  it("accepts an injected time source", () => {
    const { result } = renderHook(() => useTotp(RFC_URI, { now: () => 59_000 }));
    expect(result.current).toMatchObject({ status: "ok", code: "94287082" });
  });

  it("flags weak secrets", () => {
    setTime(0);
    const { result } = renderHook(() => useTotp(WEAK_URI));
    expect(result.current).toMatchObject({ status: "ok", weakSecret: true });
  });

  it("returns invalid and empty states", () => {
    const hotp = renderHook(() => useTotp("otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=1"));
    expect(hotp.result.current).toEqual({ status: "invalid", error: "hotp_unsupported" });
    expect(renderHook(() => useTotp("nonsense!")).result.current).toEqual({
      status: "invalid",
      error: "invalid_secret",
    });
    expect(renderHook(() => useTotp(undefined)).result.current).toEqual({ status: "empty" });
    expect(renderHook(() => useTotp("  ")).result.current).toEqual({ status: "empty" });
  });

  it("re-parses when the uri changes", () => {
    setTime(59);
    const { result, rerender } = renderHook(({ uri }) => useTotp(uri), {
      initialProps: { uri: RFC_URI as string | undefined },
    });
    expect(result.current.status).toBe("ok");
    rerender({ uri: undefined });
    expect(result.current.status).toBe("empty");
    rerender({ uri: RFC_URI });
    expect(result.current).toMatchObject({ status: "ok", code: "94287082" });
  });

  it("stops ticking while the tab is hidden and resyncs when it returns", () => {
    setTime(29);
    const tab = stubDocumentHidden();
    try {
      const { result } = renderHook(() => useTotp(RFC_URI));
      const code = () => (result.current.status === "ok" ? result.current.code : null);
      expect(code()).toBe("84755224");

      act(() => tab.set(true));
      expect(vi.getTimerCount()).toBe(0);
      advance(5_000);
      expect(code()).toBe("84755224");

      act(() => tab.set(false));
      expect(code()).toBe("94287082");
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      tab.restore();
    }
  });

  it("does not start ticking when mounted in a hidden tab", () => {
    setTime(29);
    const tab = stubDocumentHidden();
    try {
      act(() => tab.set(true));
      renderHook(() => useTotp(RFC_URI));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      tab.restore();
    }
  });

  it("clears its timer and listener on unmount", () => {
    setTime(29);
    const { unmount } = renderHook(() => useTotp(RFC_URI));
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("TotpCode", () => {
  it("shows the grouped code, issuer and a copy button", () => {
    setTime(1111111111);
    render(<TotpCode uri={RFC_URI} />);
    expect(screen.getByTestId("totp-code")).toHaveTextContent("1405 0471");
    expect(screen.getByText("Example · alice@example.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy code" })).toBeInTheDocument();
    expect(screen.getByRole("timer")).toHaveTextContent("29");
    expect(screen.queryByText(/^Next:/)).not.toBeInTheDocument();
  });

  it("copies the raw digits", async () => {
    setTime(1111111111);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    try {
      render(<TotpCode uri={RFC_URI} />);
      await act(async () => {
        screen.getByRole("button", { name: "Copy code" }).click();
      });
      expect(writeText).toHaveBeenCalledWith("14050471");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("goes amber and shows the next code in the last 5 seconds", () => {
    setTime(24); // 6 s left
    render(<TotpCode uri={RFC_URI} />);
    expect(screen.queryByText(/^Next:/)).not.toBeInTheDocument();
    expect(screen.getByTestId("totp-code")).not.toHaveClass("text-amber-600");

    advance(1_000); // 5 s left
    expect(screen.getByRole("timer")).toHaveTextContent("5");
    expect(screen.getByText("Next: 9428 7082")).toBeInTheDocument();
    expect(screen.getByTestId("totp-code")).toHaveClass("text-amber-600");

    advance(5_000); // new period
    expect(screen.queryByText(/^Next:/)).not.toBeInTheDocument();
    expect(screen.getByTestId("totp-code")).toHaveTextContent("9428 7082");
  });

  it("draws the ring with SVG attributes, not inline styles", () => {
    setTime(1111111111);
    const { container } = render(<TotpCode uri={RFC_URI} />);
    const arc = container.querySelector("circle[stroke-dasharray]");
    expect(arc).not.toBeNull();
    expect(arc?.getAttribute("stroke-dashoffset")).toBeTruthy();
    expect(container.querySelector("[style]")).toBeNull();
  });

  it("announces only when the code changes", () => {
    setTime(10);
    render(<TotpCode uri={RFC_URI} />);
    const live = document.querySelector('[aria-live="polite"]') as HTMLElement;
    expect(live).toHaveTextContent("Authenticator code 8475 5224");
    const mutations = vi.fn();
    const observer = new MutationObserver(mutations);
    observer.observe(live, { childList: true, characterData: true, subtree: true });
    advance(5_000); // seconds tick, code unchanged
    expect(observer.takeRecords()).toHaveLength(0);
    advance(15_000); // crosses the boundary at t=30
    expect(observer.takeRecords().length).toBeGreaterThan(0);
    expect(live).toHaveTextContent("Authenticator code 9428 7082");
    observer.disconnect();
  });

  it("warns about weak secrets", () => {
    setTime(0);
    render(<TotpCode uri={WEAK_URI} />);
    expect(screen.getByText("Weak secret")).toBeInTheDocument();
  });

  it("shows an error for an invalid URI", () => {
    render(<TotpCode uri="otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=1" />);
    expect(screen.getByRole("alert")).toHaveTextContent(/HOTP/);
    expect(screen.queryByTestId("totp-code")).not.toBeInTheDocument();
  });

  it("shows a hint for an empty URI", () => {
    render(<TotpCode uri="" />);
    expect(screen.getByText("No authenticator code set.")).toBeInTheDocument();
  });
});

describe("TotpBadge", () => {
  it("shows the code and copies it on click without bubbling", async () => {
    setTime(1111111111);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const onRow = vi.fn();
    try {
      render(
        // biome-ignore lint/a11y/useKeyWithClickEvents: test wrapper standing in for a list row
        // biome-ignore lint/a11y/noStaticElementInteractions: test wrapper standing in for a list row
        <div onClick={onRow}>
          <TotpBadge uri={RFC_URI} />
        </div>,
      );
      expect(screen.getByTestId("totp-badge-code")).toHaveTextContent("1405 0471");
      await act(async () => {
        screen.getByRole("button", { name: "Copy one-time code" }).click();
      });
      expect(writeText).toHaveBeenCalledWith("14050471");
      expect(onRow).not.toHaveBeenCalled();
      expect(screen.getByTestId("totp-badge-code")).toHaveTextContent("Copied");
      advance(2_500);
      expect(screen.getByTestId("totp-badge-code")).toHaveTextContent("1405 0471");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("renders a short notice for invalid URIs and nothing for empty ones", () => {
    const { container, rerender } = render(<TotpBadge uri="garbage!" />);
    expect(container).toHaveTextContent("Invalid code setup");
    rerender(<TotpBadge uri="" />);
    expect(container).toBeEmptyDOMElement();
  });
});
