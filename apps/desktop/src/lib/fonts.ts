import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  DesktopFontCatalog,
  DesktopFontFamily,
  DesktopFontImportResult,
  DesktopFontReference,
  DesktopSettings,
} from "@pideck/protocol";

export type FontPreferences = Pick<DesktopSettings, "uiFont" | "textFont" | "codeFont">;
export const FONT_CHANGED_EVENT = "pideck:typography-changed";
const FONT_LIBRARY_EVENT = "pideck:font-library-changed";
export const FONT_FIELDS = ["uiFont", "textFont", "codeFont"] as const;
const catalogs = new Map<boolean, Promise<DesktopFontCatalog>>();
const loaded = new Map<string, Promise<FontFace[]>>();
const errors = new Map<string, string>();
let generation = 0;
let appliedKey = "";
let active: FontPreferences = {};
let validateActiveSystem = true;
let revision = 0;

export function fontReferenceKey(reference: DesktopFontReference | undefined): string {
  if (!reference || reference.source === "default") return "default";
  return reference.source === "system" ? "system:" + reference.family : "imported:" + reference.id;
}

export function isFontReference(value: unknown): value is DesktopFontReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  if (ref.source === "default") return Object.keys(ref).length === 1;
  if (ref.source === "system") {
    return (
      Object.keys(ref).length === 2 &&
      typeof ref.family === "string" &&
      ref.family.trim().length > 0 &&
      new TextEncoder().encode(ref.family).length <= 512 &&
      !/[\u0000-\u001f\u007f-\u009f]/u.test(ref.family)
    );
  }
  return (
    ref.source === "imported" &&
    Object.keys(ref).length === 2 &&
    typeof ref.id === "string" &&
    /^[a-f0-9]{64}$/.test(ref.id)
  );
}

export function familyReference(family: DesktopFontFamily): DesktopFontReference {
  return family.source === "system"
    ? { source: "system", family: family.family }
    : { source: "imported", id: family.id };
}

export function fontCssFamily(reference: DesktopFontReference): string | undefined {
  if (reference.source === "default") return undefined;
  const family =
    reference.source === "system" ? reference.family : "PiDeck Imported " + reference.id;
  // A single quoted CSS family, never an arbitrary font stack or declaration.
  return '"' + family.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
}

export function fontLoadError(reference: DesktopFontReference | undefined): string | undefined {
  return errors.get(fontReferenceKey(reference));
}

export function fontLibraryRevision(): number {
  return revision;
}

export function subscribeFontLibrary(listener: () => void): () => void {
  window.addEventListener(FONT_LIBRARY_EVENT, listener);
  return () => window.removeEventListener(FONT_LIBRARY_EVENT, listener);
}

export function listFontCatalog(
  includeSystem = true,
  refresh = false,
): Promise<DesktopFontCatalog> {
  if (!isTauri()) return Promise.resolve({ families: [], systemError: "desktop-only" });
  if (refresh) catalogs.delete(includeSystem);
  let promise = catalogs.get(includeSystem);
  if (!promise) {
    promise = invoke<DesktopFontCatalog>("desktop_fonts_list", { includeSystem, refresh });
    catalogs.set(includeSystem, promise);
    void promise.then(
      (catalog) => {
        if (catalog.systemError && catalogs.get(includeSystem) === promise)
          catalogs.delete(includeSystem);
        if (refresh && !catalog.systemError) {
          appliedKey = "";
          revision += 1;
          window.dispatchEvent(new Event(FONT_LIBRARY_EVENT));
          applyFontPreferences(active, validateActiveSystem);
        }
      },
      () => {
        if (catalogs.get(includeSystem) === promise) catalogs.delete(includeSystem);
      },
    );
  }
  return promise;
}

export function invalidateFontLibrary(): void {
  catalogs.clear();
  errors.clear();
  for (const promise of loaded.values()) {
    void promise.then(
      (faces) => faces.forEach((face) => document.fonts?.delete(face)),
      () => {},
    );
  }
  loaded.clear();
  appliedKey = "";
  revision += 1;
  window.dispatchEvent(new Event(FONT_LIBRARY_EVENT));
  applyFontPreferences(active, validateActiveSystem);
}

export async function importFonts(paths: string[]): Promise<DesktopFontImportResult> {
  const result = await invoke<DesktopFontImportResult>("desktop_fonts_import", { paths });
  invalidateFontLibrary();
  return result;
}

async function loadImported(family: DesktopFontFamily): Promise<void> {
  let promise = loaded.get(family.id);
  if (!promise) {
    promise = (async () => {
      const faces: FontFace[] = [];
      try {
        for (const descriptor of family.faces) {
          const data = await invoke<ArrayBuffer | number[]>("desktop_font_read", {
            id: descriptor.id,
          });
          const bytes = data instanceof ArrayBuffer ? data : new Uint8Array(data).buffer;
          const face = new FontFace("PiDeck Imported " + family.id, bytes, {
            weight: descriptor.weight,
            style: descriptor.style,
            stretch: descriptor.stretch,
            display: "swap",
          });
          await face.load();
          faces.push(face);
        }
        if (!faces.length) throw new Error("Font contains no readable faces");
        faces.forEach((face) => document.fonts.add(face));
        return faces;
      } catch (error) {
        faces.forEach((face) => document.fonts.delete(face));
        throw error;
      }
    })();
    loaded.set(family.id, promise);
    void promise.catch(() => {
      if (loaded.get(family.id) === promise) loaded.delete(family.id);
    });
  }
  await promise;
}

export async function prepareFont(
  reference: DesktopFontReference | undefined,
  validateSystem = true,
): Promise<string | undefined> {
  if (!reference || reference.source === "default") return undefined;
  if (!isFontReference(reference)) throw new Error("Invalid font reference");
  if (reference.source === "system" && !validateSystem) {
    const css = fontCssFamily(reference);
    if (css && document.fonts?.load) await document.fonts.load("14px " + css, "Aa中文");
    return css;
  }
  const catalog = await listFontCatalog(reference.source === "system");
  const family = catalog.families.find(
    (candidate) => fontReferenceKey(familyReference(candidate)) === fontReferenceKey(reference),
  );
  if (!family) throw new Error(catalog.systemError ?? "Font is unavailable");
  if (reference.source === "imported") await loadImported(family);
  const css = fontCssFamily(reference);
  if (document.fonts?.load && css) await document.fonts.load("14px " + css, "Aa中文");
  return css;
}

export function applyFontPreferences(
  settings: FontPreferences | null | undefined,
  validateSystem = true,
): void {
  if (typeof document === "undefined") return;
  active = settings ?? {};
  validateActiveSystem = validateSystem;
  const key = JSON.stringify(FONT_FIELDS.map((field) => fontReferenceKey(active[field])));
  if (key === appliedKey) return;
  appliedKey = key;
  const current = ++generation;
  const preferences = active;
  const variables = ["--font-sans", "--font-text", "--font-mono"];
  const defaults = ["--font-default-sans", "--font-default-sans", "--font-default-mono"];
  // Default selections update synchronously; other fonts swap only after loading.
  FONT_FIELDS.forEach((field, index) => {
    if (fontReferenceKey(preferences[field]) === "default")
      document.documentElement.style.removeProperty(variables[index]);
  });
  void Promise.all(
    FONT_FIELDS.map(async (field, index) => {
      const reference = preferences[field];
      let family: string | undefined;
      try {
        family = await prepareFont(reference, validateSystem);
        if (current === generation) errors.delete(fontReferenceKey(reference));
      } catch (error) {
        if (current === generation) errors.set(fontReferenceKey(reference), String(error));
      }
      if (current !== generation) return;
      const root = document.documentElement.style;
      if (family) root.setProperty(variables[index], family + ", var(" + defaults[index] + ")");
      else root.removeProperty(variables[index]);
    }),
  ).then(() => {
    if (current === generation) window.dispatchEvent(new Event(FONT_CHANGED_EVENT));
  });
}
