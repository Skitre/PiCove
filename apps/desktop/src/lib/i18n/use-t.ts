import { useMemo } from "react";
import { useAppStore } from "../stores/app-store";
import { resolveLocale, translate, type Locale, type MessageKey } from "./index";

export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

export function useLocale(): Locale {
  return useAppStore((state) =>
    resolveLocale(state.desktopSettings?.language ?? state.surfaceLanguage),
  );
}

/** Translation function bound to the current UI language. */
export function useT(): Translate {
  const locale = useLocale();
  return useMemo<Translate>(() => (key, params) => translate(locale, key, params), [locale]);
}

/**
 * Non-hook translate for action modules (notifications from plain functions).
 * Reads the language at call time; components should use useT instead.
 */
export function tCurrent(key: MessageKey, params?: Record<string, string | number>): string {
  return translate(resolveLocale(useAppStore.getState().desktopSettings?.language), key, params);
}
