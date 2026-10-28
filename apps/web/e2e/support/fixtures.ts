import { type BrowserContext, test as base, expect, type Page } from "@playwright/test";
import { E2E_ORIGIN } from "./env.ts";

/** Everything the security smoke test cares about, collected across all pages of a test. */
export interface Monitor {
  cspViolations: string[];
  pageErrors: string[];
}

const VIOLATION_MARKER = "[e2e-csp-violation]";

/**
 * Hooks a context so that every page in it reports uncaught errors and Content-Security-Policy
 * violations (both the console message and the `securitypolicyviolation` DOM event).
 */
export async function watchContext(context: BrowserContext, monitor: Monitor): Promise<void> {
  await context.addInitScript((marker) => {
    document.addEventListener("securitypolicyviolation", (event) => {
      console.error(
        `${marker} ${event.violatedDirective} ${event.blockedURI} at ${event.sourceFile}:${event.lineNumber}:${event.columnNumber} ${event.sample}`,
      );
    });
  }, VIOLATION_MARKER);

  const attach = (page: Page) => {
    page.on("pageerror", (error) => monitor.pageErrors.push(`${page.url()}: ${error.message}`));
    page.on("console", (message) => {
      const text = message.text();
      if (text.includes(VIOLATION_MARKER) || /content security policy/i.test(text)) {
        monitor.cspViolations.push(text);
      }
    });
  };
  for (const page of context.pages()) attach(page);
  context.on("page", attach);
}

interface Fixtures {
  monitor: Monitor;
  /** A fresh, isolated browser context (= one user's browser) that is watched like the default. */
  newUser: () => Promise<Page>;
}

export const test = base.extend<Fixtures>({
  monitor: [
    async ({ context }, use) => {
      const monitor: Monitor = { cspViolations: [], pageErrors: [] };
      await watchContext(context, monitor);
      await use(monitor);
      expect(monitor.cspViolations, "CSP violations").toEqual([]);
      expect(monitor.pageErrors, "uncaught page errors").toEqual([]);
    },
    { auto: true },
  ],
  newUser: async ({ browser, baseURL, monitor }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async () => {
      const context = await browser.newContext({ baseURL: baseURL ?? E2E_ORIGIN });
      contexts.push(context);
      await watchContext(context, monitor);
      return context.newPage();
    });
    await Promise.all(contexts.map((c) => c.close()));
  },
});

export { expect };
