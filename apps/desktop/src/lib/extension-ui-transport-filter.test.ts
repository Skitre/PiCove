import { describe, expect, it } from "vitest";
import {
  filterExtensionUiTransportContent,
  filterExtensionUiTransportLines,
  isExtensionUiTransportEmpty,
  isExtensionUiTransportLine,
} from "./extension-ui-transport-filter";

describe("isExtensionUiTransportLine", () => {
  it("matches only PI_SUBAGENT transport lines", () => {
    expect(isExtensionUiTransportLine('PI_SUBAGENT_abc_JSON: {"a":1}')).toBe(true);
    expect(isExtensionUiTransportLine("PI_SUBAGENT_agent-1_JSON: [1]")).toBe(true);
    expect(isExtensionUiTransportLine("PI_SUBAGENT_JSON: plain")).toBe(false);
    expect(isExtensionUiTransportLine("fleet: 2 running")).toBe(false);
    expect(isExtensionUiTransportLine("note PI_SUBAGENT_abc_JSON: inline")).toBe(false);
  });
});

describe("filterExtensionUiTransportLines", () => {
  it("keeps non-transport lines in order", () => {
    expect(
      filterExtensionUiTransportLines(
        "PI_SUBAGENT_abc_JSON: 1\nfleet: 2 running\nPI_SUBAGENT_def_JSON: 3\ndone",
      ),
    ).toBe("fleet: 2 running\ndone");
  });

  it("treats fully-transport text as empty", () => {
    expect(
      filterExtensionUiTransportLines("PI_SUBAGENT_abc_JSON: 1\nPI_SUBAGENT_def_JSON: 2"),
    ).toBe("");
    expect(filterExtensionUiTransportLines("PI_SUBAGENT_abc_JSON: 1")).toBe("");
  });
});

describe("filterExtensionUiTransportContent", () => {
  it("filters string arrays element-wise and drops emptied elements", () => {
    expect(
      filterExtensionUiTransportContent([
        "fleet: 1",
        "PI_SUBAGENT_abc_JSON: 2",
        "PI_SUBAGENT_def_JSON: 3",
      ]),
    ).toEqual(["fleet: 1"]);
    expect(filterExtensionUiTransportContent(["PI_SUBAGENT_abc_JSON: 1"])).toEqual([]);
  });

  it("returns non-string content unchanged", () => {
    const object = { fleet: 1 };
    expect(filterExtensionUiTransportContent(object)).toBe(object);
    expect(filterExtensionUiTransportContent(42)).toBe(42);
    expect(filterExtensionUiTransportContent(true)).toBe(true);
    expect(filterExtensionUiTransportContent(["fleet: 1", 2])).toEqual(["fleet: 1", 2]);
  });
});

describe("isExtensionUiTransportEmpty", () => {
  it("marks empty strings and empty arrays only", () => {
    expect(isExtensionUiTransportEmpty("")).toBe(true);
    expect(isExtensionUiTransportEmpty([])).toBe(true);
    expect(isExtensionUiTransportEmpty(["fleet: 1"])).toBe(false);
    expect(isExtensionUiTransportEmpty({})).toBe(false);
    expect(isExtensionUiTransportEmpty("fleet: 1")).toBe(false);
  });
});
