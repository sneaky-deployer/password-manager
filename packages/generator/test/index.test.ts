import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/index.ts";

describe("@pm/generator", () => {
  it("exports its package name", () => {
    expect(PACKAGE_NAME).toBe("@pm/generator");
  });
});
