/**
 * Temporary non-visual compatibility handling for `PI_SUBAGENT_*_JSON:` transport
 * lines (extension-deck.md, Renderer registry). Content sniffing is not a general
 * renderer contract; replacing it needs an explicit protocol change.
 */
const TRANSPORT_LINE_PATTERN = /^PI_SUBAGENT_.*_JSON:/;

export function isExtensionUiTransportLine(line: string): boolean {
  return TRANSPORT_LINE_PATTERN.test(line);
}

/** Drop transport lines from a single text. Fully-transport text becomes "". */
export function filterExtensionUiTransportLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !isExtensionUiTransportLine(line))
    .join("\n");
}

/**
 * Strip transport lines from string content; `string[]` content drops whole
 * emptied elements the same way. Non-string content is returned unchanged.
 */
export function filterExtensionUiTransportContent(content: unknown): unknown {
  if (typeof content === "string") return filterExtensionUiTransportLines(content);
  if (Array.isArray(content) && content.every((element) => typeof element === "string")) {
    return content
      .map((element) => filterExtensionUiTransportLines(element))
      .filter((element) => element !== "");
  }
  return content;
}

/** True when filtered content has no visible rows left. */
export function isExtensionUiTransportEmpty(content: unknown): boolean {
  return content === "" || (Array.isArray(content) && content.length === 0);
}
