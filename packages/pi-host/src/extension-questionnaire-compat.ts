import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SourceInfo } from "@earendil-works/pi-coding-agent";
import type { ExtensionInvocationContext } from "./extension-invocation-context.js";

const supportedSources = new WeakMap<SourceInfo, boolean>();

function supportsCustomInput(source: SourceInfo): boolean {
  const cached = supportedSources.get(source);
  if (cached !== undefined) return cached;
  let supported = false;
  try {
    const manifest = JSON.parse(
      readFileSync(join(dirname(source.path), "package.json"), "utf8"),
    ) as { name?: unknown; version?: unknown };
    supported =
      manifest.name === "@juicesharp/rpiv-ask-user-question" &&
      (manifest.version === "2.1.0" || manifest.version === "2.6.1");
  } catch {
    // Unknown sources keep the standard SDK select/input behavior.
  }
  supportedSources.set(source, supported);
  return supported;
}

/**
 * rpiv 2.1.0 / 2.6.1 append a numbered custom-answer row, then immediately await
 * ui.input when that row is chosen. Keep select pending until custom text is
 * submitted so Desktop can go back without falsifying an option as a custom
 * answer. Scope this adapter to the published implementation we exercise.
 */
export function questionnaireCustomOptionIndex(
  invocation: ExtensionInvocationContext | undefined,
  options: string[],
): number | undefined {
  if (
    !invocation?.active ||
    invocation.origin.invocationKind !== "tool" ||
    invocation.origin.toolName !== "ask_user_question" ||
    !invocation.sourceInfo ||
    !supportsCustomInput(invocation.sourceInfo) ||
    options.length < 2 ||
    !options.every((option, index) => option.startsWith(`${index + 1}. `)) ||
    !options.slice(0, -1).every((option) => option.includes(" — "))
  ) {
    return undefined;
  }
  return options.length - 1;
}

export function isQuestionnaireCustomResponse(
  value: unknown,
  optionId: string,
): value is { optionId: string; input: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  return (
    Object.keys(response).length === 2 &&
    response.optionId === optionId &&
    typeof response.input === "string"
  );
}
