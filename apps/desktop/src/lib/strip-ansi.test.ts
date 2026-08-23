import { describe, expect, it } from "vitest";
import { stripAnsi } from "./strip-ansi";

describe("stripAnsi", () => {
  it("removes CSI sequences and keeps plain text", () => {
    expect(stripAnsi("\u001b[32mready\u001b[0m")).toBe("ready");
    expect(stripAnsi("\u001b[1;31mfleet: \u001b[0m2 running")).toBe("fleet: 2 running");
    expect(stripAnsi("plain")).toBe("plain");
    expect(stripAnsi("\u001b[?25lhidden\u001b[?25h")).toBe("hidden");
  });
});
