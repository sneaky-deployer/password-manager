import { SECURITY_HEADERS } from "@pm/shared";
import { describe, expect, it } from "vitest";
import headersFile from "../public/_headers?raw";

function parseHeadersFile(text: string): { path: string; headers: Record<string, string> }[] {
  const rules: { path: string; headers: Record<string, string> }[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    if (!line.startsWith(" ")) {
      rules.push({ path: line.trim(), headers: {} });
      continue;
    }
    const current = rules.at(-1);
    const sep = line.indexOf(":");
    if (!current || sep === -1) throw new Error(`Unexpected line in _headers: ${line}`);
    current.headers[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
  }
  return rules;
}

describe("public/_headers", () => {
  it("applies exactly the shared security headers to every static asset", () => {
    const rules = parseHeadersFile(headersFile);
    expect(rules).toEqual([{ path: "/*", headers: { ...SECURITY_HEADERS } }]);
  });
});
