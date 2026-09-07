//! Application-private font library. No font files are registered with the OS.
use font_kit::source::SystemSource;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, State};
use write_fonts::read::{tables::os2::SelectionFlags, FontRef, TableProvider};
use write_fonts::types::{NameId, Tag};
use write_fonts::FontBuilder;

const MAX_FONT_BYTES: u64 = 128 * 1024 * 1024;
const MAX_BATCH_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ENTRIES: usize = 1_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "source", rename_all = "lowercase", deny_unknown_fields)]
pub enum FontReference {
    Default {},
    System { family: String },
    Imported { id: String },
}

impl FontReference {
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::Default {} => Ok(()),
            Self::System { family } if valid_family(family) => Ok(()),
            Self::Imported { id } if valid_id(id) => Ok(()),
            _ => Err("Invalid font reference".into()),
        }
    }
}

fn valid_family(family: &str) -> bool {
    !family.trim().is_empty() && family.len() <= 512 && !family.chars().any(char::is_control)
}

fn valid_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn hash(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FontFace {
    pub id: String,
    pub weight: String,
    pub style: String,
    pub stretch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FontFamily {
    pub id: String,
    pub family: String,
    pub source: String,
    pub monospace: bool,
    pub faces: Vec<FontFace>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontCatalog {
    families: Vec<FontFamily>,
    #[serde(skip_serializing_if = "Option::is_none")]
    system_error: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct FontLibrary {
    families: Vec<FontFamily>,
}

#[derive(Serialize)]
pub struct ImportItem {
    name: String,
    status: &'static str,
    detail: String,
}

#[derive(Default, Serialize)]
pub struct ImportResult {
    items: Vec<ImportItem>,
}

impl ImportResult {
    fn push(&mut self, name: &str, status: &'static str, detail: impl ToString) {
        self.items.push(ImportItem {
            name: name.into(),
            status,
            detail: detail.to_string(),
        });
    }
}

pub struct FontStore {
    dir: PathBuf,
    system: Option<Vec<FontFamily>>,
}

impl FontStore {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir, system: None }
    }

    fn library(&self) -> Result<FontLibrary, String> {
        let path = self.dir.join("library.json");
        if !path.exists() {
            return Ok(FontLibrary::default());
        }
        let library: FontLibrary = serde_json::from_slice(&read_bounded(&path, 8 * 1024 * 1024)?)
            .map_err(|e| format!("Could not read font library: {e}"))?;
        for family in &library.families {
            if !valid_id(&family.id)
                || !valid_family(&family.family)
                || family.source != "imported"
                || family.faces.iter().any(|face| !valid_id(&face.id))
            {
                return Err("Invalid font library metadata".into());
            }
        }
        Ok(library)
    }

    fn save(&self, library: &FontLibrary) -> Result<(), String> {
        atomic_write(
            &self.dir.join("library.json"),
            &serde_json::to_vec(library).map_err(|e| e.to_string())?,
        )
    }

    fn list(&mut self, include_system: bool, refresh: bool) -> Result<FontCatalog, String> {
        let mut families = self.library()?.families;
        let mut system_error = None;
        if include_system {
            if refresh || self.system.is_none() {
                match system_families() {
                    Ok(fonts) => self.system = Some(fonts),
                    Err(error) => system_error = Some(error),
                }
            }
            families.extend(self.system.clone().unwrap_or_default());
        }
        families.sort_by_cached_key(|font| font.family.to_lowercase());
        Ok(FontCatalog {
            families,
            system_error,
        })
    }

    fn read(&self, id: &str) -> Result<Vec<u8>, String> {
        if !valid_id(id)
            || !self
                .library()?
                .families
                .iter()
                .any(|f| f.faces.iter().any(|face| face.id == id))
        {
            return Err("Font is not in the imported library".into());
        }
        read_bounded(&self.dir.join(format!("{id}.font")), MAX_FONT_BYTES)
    }

    fn remove(&self, id: &str) -> Result<(), String> {
        if !valid_id(id) {
            return Err("Invalid font id".into());
        }
        let mut library = self.library()?;
        let Some(index) = library.families.iter().position(|family| family.id == id) else {
            return Err("Font is not in the imported library".into());
        };
        let removed = library.families.remove(index);
        self.save(&library)?;
        for face in removed.faces {
            if !library
                .families
                .iter()
                .any(|f| f.faces.iter().any(|other| other.id == face.id))
            {
                // The manifest is authoritative; an interrupted cleanup only leaves unused bytes.
                let _ = fs::remove_file(self.dir.join(format!("{}.font", face.id)));
            }
        }
        Ok(())
    }

    fn import(&self, paths: Vec<PathBuf>) -> Result<ImportResult, String> {
        if paths.len() > MAX_ENTRIES {
            return Err("Batch exceeds 1,000 entries".into());
        }
        let mut library = self.library()?;
        let mut result = ImportResult::default();
        let mut budget = ImportBudget::default();
        for path in paths {
            let name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            let outcome = (|| -> Result<(), String> {
                if extension(&path) == "zip" {
                    let file = open_regular(&path)?;
                    if file.metadata().map_err(|e| e.to_string())?.len() > MAX_BATCH_BYTES {
                        return Err("ZIP exceeds 512 MiB".into());
                    }
                    let mut archive =
                        zip::ZipArchive::new(file).map_err(|e| format!("Invalid ZIP: {e}"))?;
                    if archive.len() > MAX_ENTRIES.saturating_sub(budget.entries) {
                        return Err("Batch exceeds 1,000 entries".into());
                    }
                    for index in 0..archive.len() {
                        budget.entry()?;
                        let mut entry = match archive.by_index(index) {
                            Ok(entry) => entry,
                            Err(error) => {
                                result.push(&format!("{name} #{index}"), "failed", error);
                                continue;
                            }
                        };
                        let entry_name = format!("{name}/{}", entry.name());
                        let safe = entry.enclosed_name();
                        if safe.is_none()
                            || entry.name().contains('\\')
                            || entry.encrypted()
                            || entry
                                .unix_mode()
                                .is_some_and(|mode| mode & 0o170000 == 0o120000)
                        {
                            result.push(&entry_name, "failed", "Unsafe or encrypted ZIP entry");
                            continue;
                        }
                        if entry.is_dir() {
                            continue;
                        }
                        if !supported(safe.as_deref().unwrap()) {
                            result.push(&entry_name, "skipped", "Unsupported file type");
                            continue;
                        }
                        let data = budget.read(&mut entry, MAX_FONT_BYTES);
                        match data {
                            Ok(data) => self.import_data(
                                &entry_name,
                                &data,
                                &mut library,
                                &mut budget,
                                &mut result,
                            ),
                            Err(error) => result.push(&entry_name, "failed", error),
                        }
                    }
                } else if supported(&path) {
                    budget.entry()?;
                    let data = budget.read(&mut open_regular(&path)?, MAX_FONT_BYTES)?;
                    self.import_data(&name, &data, &mut library, &mut budget, &mut result);
                } else {
                    budget.entry()?;
                    return Err("Supported files: TTF, OTF, TTC and ZIP".into());
                }
                Ok(())
            })();
            if let Err(error) = outcome {
                result.push(&name, "failed", error);
            }
        }
        Ok(result)
    }

    fn import_data(
        &self,
        name: &str,
        data: &[u8],
        library: &mut FontLibrary,
        budget: &mut ImportBudget,
        result: &mut ImportResult,
    ) {
        let mut count = 0;
        for parsed in FontRef::fonts(data) {
            count += 1;
            if count > MAX_ENTRIES || budget.faces >= MAX_ENTRIES {
                result.push(name, "failed", "Batch exceeds 1,000 font faces");
                break;
            }
            budget.faces += 1;
            let outcome = (|| -> Result<(String, &'static str), String> {
                let font = parsed.map_err(|e| format!("Invalid font: {e}"))?;
                let (family_name, monospace, mut face) = metadata(&font)?;
                // Rebuild collections into standalone sfnt files; keep all tables/variation data.
                let bytes = if data.starts_with(b"ttcf") {
                    let mut builder = FontBuilder::new();
                    let mut size = 12_u64;
                    for record in font.table_directory().table_records() {
                        let tag = record.tag();
                        // A collection's digital signature does not describe the extracted file.
                        if tag == Tag::new(b"DSIG") {
                            continue;
                        }
                        let table = font.data_for_tag(tag).ok_or("Invalid font table offset")?;
                        size += table.len() as u64 + 19;
                        if size > MAX_FONT_BYTES || budget.output + size > MAX_BATCH_BYTES {
                            return Err("Extracted font exceeds the import size limit".into());
                        }
                        builder.add_raw(tag, table.as_bytes());
                    }
                    builder.build()
                } else {
                    data.to_vec()
                };
                if bytes.len() as u64 > MAX_FONT_BYTES
                    || budget.output + bytes.len() as u64 > MAX_BATCH_BYTES
                {
                    return Err("Extracted fonts exceed the import size limit".into());
                }
                budget.output += bytes.len() as u64;
                face.id = hash(&bytes);
                if library
                    .families
                    .iter()
                    .any(|f| f.faces.iter().any(|existing| existing.id == face.id))
                {
                    return Ok((family_name, "skipped"));
                }
                let id = hash(family_name.to_lowercase().as_bytes());
                if library
                    .families
                    .iter()
                    .find(|family| family.id == id)
                    .is_some_and(|family| {
                        family
                            .faces
                            .iter()
                            .any(|existing| faces_overlap(existing, &face))
                    })
                {
                    return Err(format!("{family_name}: this style/weight already exists; remove the family before replacing it"));
                }
                let target = self.dir.join(format!("{}.font", face.id));
                atomic_write(&target, &bytes)?;
                let mut next = FontLibrary {
                    families: library.families.clone(),
                };
                if let Some(family) = next.families.iter_mut().find(|family| family.id == id) {
                    family.monospace &= monospace;
                    family.faces.push(face);
                } else {
                    next.families.push(FontFamily {
                        id,
                        family: family_name.clone(),
                        source: "imported".into(),
                        monospace,
                        faces: vec![face],
                    });
                }
                if let Err(error) = self.save(&next) {
                    let _ = fs::remove_file(target);
                    return Err(error);
                }
                *library = next;
                Ok((family_name, "imported"))
            })();
            match outcome {
                Ok((detail, status)) => result.push(name, status, detail),
                Err(error) => result.push(name, "failed", error),
            }
        }
        if count == 0 {
            result.push(name, "failed", "No readable font faces");
        }
    }
}

#[derive(Default)]
struct ImportBudget {
    bytes: u64,
    output: u64,
    entries: usize,
    faces: usize,
}

impl ImportBudget {
    fn entry(&mut self) -> Result<(), String> {
        self.entries += 1;
        if self.entries > MAX_ENTRIES {
            Err("Batch exceeds 1,000 entries".into())
        } else {
            Ok(())
        }
    }
    fn read(&mut self, reader: &mut impl Read, limit: u64) -> Result<Vec<u8>, String> {
        let max = limit.min(MAX_BATCH_BYTES.saturating_sub(self.bytes));
        let mut bytes = Vec::new();
        let read = reader.take(max + 1).read_to_end(&mut bytes);
        self.bytes += bytes.len() as u64;
        read.map_err(|e| e.to_string())?;
        if bytes.len() as u64 > max {
            return Err("Font or batch exceeds the import size limit".into());
        }
        Ok(bytes)
    }
}

fn open_regular(path: &Path) -> Result<File, String> {
    if !fs::symlink_metadata(path)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_file()
    {
        return Err("Expected a regular file".into());
    }
    File::open(path).map_err(|e| e.to_string())
}

fn read_bounded(path: &Path, max: u64) -> Result<Vec<u8>, String> {
    ImportBudget::default().read(&mut open_regular(path)?, max)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Missing font directory")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temp = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = File::create(&temp).map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        crate::desktop_settings::replace_file(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

fn extension(path: &Path) -> String {
    path.extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase()
}
fn supported(path: &Path) -> bool {
    matches!(extension(path).as_str(), "ttf" | "otf" | "ttc")
}

fn metadata(font: &FontRef<'_>) -> Result<(String, bool, FontFace), String> {
    // Require the tables browsers need, rather than accepting a file with just a name table.
    font.head().map_err(|e| e.to_string())?;
    font.maxp().map_err(|e| e.to_string())?;
    font.cmap().map_err(|e| e.to_string())?;
    font.hhea().map_err(|e| e.to_string())?;
    if font.data_for_tag(Tag::new(b"glyf")).is_none()
        && font.data_for_tag(Tag::new(b"CFF ")).is_none()
        && font.data_for_tag(Tag::new(b"CFF2")).is_none()
    {
        return Err("Font has no supported outlines".into());
    }
    let names = font.name().map_err(|e| e.to_string())?;
    let mut family = None;
    for id in [NameId::TYPOGRAPHIC_FAMILY_NAME, NameId::FAMILY_NAME] {
        let mut records: Vec<_> = names
            .name_record()
            .iter()
            .filter(|r| r.name_id() == id)
            .collect();
        records.sort_by_key(|r| (r.language_id() != 0x409, !r.is_unicode()));
        family = records.iter().find_map(|r| {
            r.string(names.string_data())
                .ok()
                .map(|s| s.to_string())
                .filter(|s| valid_family(s))
        });
        if family.is_some() {
            break;
        }
    }
    let family = family.ok_or("Font has no valid family name")?;
    let os2 = font.os2().map_err(|e| e.to_string())?;
    let mut weight = os2.us_weight_class().clamp(1, 1000).to_string();
    let widths = [50., 62.5, 75., 87.5, 100., 112.5, 125., 150., 200.];
    let mut stretch = format!("{}%", widths[os2.us_width_class().clamp(1, 9) as usize - 1]);
    let mut style = if os2.fs_selection().contains(SelectionFlags::ITALIC) {
        "italic"
    } else if os2.fs_selection().contains(SelectionFlags::OBLIQUE) {
        "oblique"
    } else {
        "normal"
    }
    .to_string();
    if let Ok(fvar) = font.fvar() {
        for axis in fvar
            .axis_instance_arrays()
            .map_err(|e| e.to_string())?
            .axes()
        {
            let min = axis.min_value().to_f64();
            let max = axis.max_value().to_f64();
            if min > max {
                return Err("Invalid variable font axis".into());
            }
            match &axis.axis_tag().to_be_bytes() {
                b"wght" => weight = format!("{} {}", min.clamp(1., 1000.), max.clamp(1., 1000.)),
                b"wdth" => stretch = format!("{}% {}%", min.clamp(50., 200.), max.clamp(50., 200.)),
                b"slnt" => style = format!("oblique {}deg {}deg", -max, -min),
                _ => {}
            }
        }
    }
    let monospace = font.post().is_ok_and(|post| post.is_fixed_pitch() != 0);
    Ok((
        family,
        monospace,
        FontFace {
            id: String::new(),
            weight,
            style,
            stretch,
        },
    ))
}

fn range(value: &str) -> (f64, f64) {
    let mut parts = value
        .split_whitespace()
        .filter_map(|v| v.trim_end_matches('%').parse::<f64>().ok());
    let min = parts.next().unwrap_or(0.);
    (min, parts.next().unwrap_or(min))
}

fn faces_overlap(a: &FontFace, b: &FontFace) -> bool {
    let (a_min, a_max) = range(&a.weight);
    let (b_min, b_max) = range(&b.weight);
    let (a_width_min, a_width_max) = range(&a.stretch);
    let (b_width_min, b_width_max) = range(&b.stretch);
    a.style.split_whitespace().next() == b.style.split_whitespace().next()
        && a_min <= b_max
        && b_min <= a_max
        && a_width_min <= b_width_max
        && b_width_min <= a_width_max
}

fn system_families() -> Result<Vec<FontFamily>, String> {
    let source = SystemSource::new();
    let handles = source
        .all_fonts()
        .map_err(|e| format!("Could not list system fonts: {e}"))?;
    let mut families = BTreeMap::<String, FontFamily>::new();
    for handle in handles {
        let Ok(font) = handle.load() else { continue };
        let family = font.family_name();
        if !valid_family(&family) || family.starts_with('.') {
            continue;
        }
        let id = hash(family.to_lowercase().as_bytes());
        families.entry(id.clone()).or_insert_with(|| FontFamily {
            id,
            family,
            source: "system".into(),
            monospace: font.is_monospace(),
            faces: Vec::new(),
        });
    }
    Ok(families.into_values().collect())
}

async fn with_store<T: Send + 'static>(
    store: Arc<Mutex<FontStore>>,
    work: impl FnOnce(&mut FontStore) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        work(&mut *store.lock().map_err(|e| e.to_string())?)
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn require_font_reader(
    webview: &tauri::Webview,
    app: &AppHandle,
    state: &crate::AppState,
) -> Result<(), String> {
    if webview.label() == "main" {
        return Ok(());
    }
    if state
        .floats
        .lock()
        .await
        .slot_for_window_label(app, webview.label())
        .is_some()
    {
        return Ok(());
    }
    Err("Font access requires a PiDeck application surface".into())
}

#[tauri::command]
pub async fn desktop_fonts_list(
    webview: tauri::Webview,
    app: AppHandle,
    state: State<'_, crate::AppState>,
    include_system: bool,
    refresh: bool,
) -> Result<FontCatalog, String> {
    require_font_reader(&webview, &app, &state).await?;
    if include_system && webview.label() != "main" {
        return Err("System font enumeration requires the main surface".into());
    }
    with_store(state.fonts.clone(), move |store| {
        store.list(include_system, refresh)
    })
    .await
}

#[tauri::command]
pub async fn desktop_font_read(
    webview: tauri::Webview,
    app: AppHandle,
    state: State<'_, crate::AppState>,
    id: String,
) -> Result<tauri::ipc::Response, String> {
    require_font_reader(&webview, &app, &state).await?;
    with_store(state.fonts.clone(), move |store| store.read(&id))
        .await
        .map(tauri::ipc::Response::new)
}

#[tauri::command]
pub async fn desktop_fonts_import(
    webview: tauri::Webview,
    state: State<'_, crate::AppState>,
    paths: Vec<PathBuf>,
) -> Result<ImportResult, String> {
    if webview.label() != "main" {
        return Err("Font import requires the main surface".into());
    }
    with_store(state.fonts.clone(), move |store| store.import(paths)).await
}

#[tauri::command]
pub async fn desktop_font_remove(
    webview: tauri::Webview,
    state: State<'_, crate::AppState>,
    id: String,
) -> Result<crate::desktop_settings::DesktopSettings, String> {
    if webview.label() != "main" {
        return Err("Font deletion requires the main surface".into());
    }
    if !valid_id(&id) {
        return Err("Invalid font id".into());
    }
    let mut settings = state.settings.lock().await;
    let mut patch = serde_json::Map::new();
    for (key, value) in [
        ("uiFont", &settings.settings.ui_font),
        ("textFont", &settings.settings.text_font),
        ("codeFont", &settings.settings.code_font),
    ] {
        if matches!(value, Some(FontReference::Imported { id: selected }) if selected == &id) {
            patch.insert(key.into(), serde_json::json!({"source": "default"}));
        }
    }
    if !patch.is_empty() {
        settings.patch(serde_json::Value::Object(patch))?;
    }
    with_store(state.fonts.clone(), move |store| store.remove(&id)).await?;
    Ok(settings.settings.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    const REGULAR: &[u8] = include_bytes!("../../../../test-fixtures/fonts/regular.ttf");
    const BOLD: &[u8] = include_bytes!("../../../../test-fixtures/fonts/bold.ttf");
    const ITALIC: &[u8] = include_bytes!("../../../../test-fixtures/fonts/italic.ttf");
    const TTC: &[u8] = include_bytes!("../../../../test-fixtures/fonts/collection.ttc");
    const VARIABLE: &[u8] = include_bytes!("../../../../test-fixtures/fonts/variable.ttf");
    const OTF: &[u8] = include_bytes!("../../../../test-fixtures/fonts/cff.otf");

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("pideck-font-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn store(&self) -> FontStore {
            FontStore::new(self.0.join("fonts"))
        }
        fn file(&self, name: &str, data: &[u8]) -> PathBuf {
            let path = self.0.join(name);
            fs::write(&path, data).unwrap();
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn imports_persists_deduplicates_and_merges_weights() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let regular = fixture.file("regular.ttf", REGULAR);
        let bold = fixture.file("bold.ttf", BOLD);
        let italic = fixture.file("italic.ttf", ITALIC);
        let result = store
            .import(vec![regular.clone(), regular, bold, italic])
            .unwrap();
        assert_eq!(
            result.items.iter().map(|i| i.status).collect::<Vec<_>>(),
            ["imported", "skipped", "imported", "imported"]
        );
        let mut reloaded = fixture.store();
        let list = reloaded.list(false, false).unwrap();
        assert_eq!(list.families.len(), 1);
        assert!(list.families[0].monospace);
        assert_eq!(list.families[0].faces.len(), 3);
        assert_eq!(list.families[0].faces[2].style, "italic");
        assert_eq!(
            reloaded.read(&list.families[0].faces[0].id).unwrap(),
            REGULAR
        );
    }

    #[test]
    fn extracts_every_collection_face_into_readable_standalone_fonts() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let result = store
            .import(vec![fixture.file("collection.ttc", TTC)])
            .unwrap();
        assert!(result.items.iter().all(|item| item.status == "imported"));
        let library = store.library().unwrap();
        assert_eq!(library.families[0].faces.len(), 2);
        for face in &library.families[0].faces {
            let bytes = store.read(&face.id).unwrap();
            assert!(!bytes.starts_with(b"ttcf"));
            let font = FontRef::new(&bytes).unwrap();
            assert_eq!(metadata(&font).unwrap().0, "PiDeck Test Mono");
            assert_eq!(
                write_fonts::read::tables::compute_checksum(&bytes),
                0xB1B0AFBA
            );
        }
    }

    #[test]
    fn preserves_cff_and_variable_weight_metadata() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let result = store
            .import(vec![
                fixture.file("variable.ttf", VARIABLE),
                fixture.file("cff.otf", OTF),
            ])
            .unwrap();
        assert!(result.items.iter().all(|item| item.status == "imported"));
        let library = store.library().unwrap();
        let variable = library
            .families
            .iter()
            .find(|f| f.family.ends_with("Variable"))
            .unwrap();
        assert_eq!(variable.faces[0].weight, "100 900");
        assert_eq!(store.read(&variable.faces[0].id).unwrap(), VARIABLE);
    }

    #[test]
    fn zip_import_is_partial_and_does_not_extract_paths_or_nested_archives() {
        let fixture = Fixture::new();
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in [
            ("nested/regular.ttf", REGULAR),
            ("broken.ttf", b"broken"),
            ("../escape.ttf", REGULAR),
            ("inner.zip", b"nested"),
            ("LICENSE.txt", b"text"),
        ] {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.add_symlink(
            "linked.ttf",
            "nested/regular.ttf",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        let bytes = zip.finish().unwrap().into_inner();
        let store = fixture.store();
        let result = store
            .import(vec![fixture.file("family.zip", &bytes)])
            .unwrap();
        assert_eq!(
            result
                .items
                .iter()
                .filter(|i| i.status == "imported")
                .count(),
            1
        );
        assert_eq!(
            result.items.iter().filter(|i| i.status == "failed").count(),
            3
        );
        assert_eq!(
            result
                .items
                .iter()
                .filter(|i| i.status == "skipped")
                .count(),
            2
        );
        assert!(!fixture.0.join("escape.ttf").exists());
    }

    #[test]
    fn reports_remaining_files_after_the_zip_entry_limit() {
        let fixture = Fixture::new();
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for index in 0..MAX_ENTRIES {
            zip.start_file(
                format!("{index}.txt"),
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        }
        let bytes = zip.finish().unwrap().into_inner();
        let result = fixture
            .store()
            .import(vec![
                fixture.file("full.zip", &bytes),
                fixture.file("remaining.ttf", REGULAR),
            ])
            .unwrap();
        assert_eq!(result.items.len(), MAX_ENTRIES + 1);
        assert!(result.items[..MAX_ENTRIES]
            .iter()
            .all(|item| item.status == "skipped"));
        assert_eq!(result.items[MAX_ENTRIES].name, "remaining.ttf");
        assert_eq!(result.items[MAX_ENTRIES].status, "failed");
    }

    #[test]
    fn conflicting_faces_do_not_replace_existing_bytes() {
        let fixture = Fixture::new();
        let store = fixture.store();
        store
            .import(vec![fixture.file("regular.ttf", REGULAR)])
            .unwrap();
        let original = FontRef::new(REGULAR).unwrap();
        let mut builder = FontBuilder::new();
        let mut head = original
            .data_for_tag(Tag::new(b"head"))
            .unwrap()
            .as_bytes()
            .to_vec();
        head[35] ^= 1; // Change a bound; preserve the family/style identity.
        builder.add_raw(Tag::new(b"head"), head);
        builder.copy_missing_tables(original);
        let conflict = builder.build();
        let result = store
            .import(vec![fixture.file("conflict.ttf", &conflict)])
            .unwrap();
        assert_eq!(result.items[0].status, "failed");
        let library = store.library().unwrap();
        assert_eq!(library.families[0].faces.len(), 1);
        assert_eq!(
            store.read(&library.families[0].faces[0].id).unwrap(),
            REGULAR
        );
    }

    #[test]
    fn deletion_revokes_reads_and_accepts_only_library_ids() {
        let fixture = Fixture::new();
        let store = fixture.store();
        store
            .import(vec![fixture.file("regular.ttf", REGULAR)])
            .unwrap();
        let family = store.library().unwrap().families.remove(0);
        assert!(store.read("../desktop-settings.json").is_err());
        assert!(store.read(&"e".repeat(64)).is_err());
        store.remove(&family.id).unwrap();
        assert!(store.library().unwrap().families.is_empty());
        assert!(store.read(&family.faces[0].id).is_err());
        assert!(!store
            .dir
            .join(format!("{}.font", family.faces[0].id))
            .exists());
    }

    #[test]
    fn bounds_input_counts_and_reads_without_trusting_declared_lengths() {
        let mut budget = ImportBudget::default();
        assert!(budget.read(&mut Cursor::new([0; 10]), 4).is_err());
        assert_eq!(budget.bytes, 5);
        budget.entries = MAX_ENTRIES;
        assert!(budget.entry().is_err());
        budget.bytes = MAX_BATCH_BYTES;
        assert!(budget.read(&mut Cursor::new([1]), MAX_FONT_BYTES).is_err());
    }

    #[test]
    fn rejects_untyped_or_path_based_font_preferences() {
        for value in [
            serde_json::json!({"source":"imported","id":"../font"}),
            serde_json::json!({"source":"system","family":"\nArial"}),
        ] {
            assert!(serde_json::from_value::<FontReference>(value)
                .unwrap()
                .validate()
                .is_err());
        }
        assert!(serde_json::from_value::<FontReference>(
            serde_json::json!({"source":"default","path":"/tmp/font"})
        )
        .is_err());
    }

    #[test]
    #[ignore = "Runs against the installed native font database"]
    fn installed_system_catalog() {
        let families = system_families().unwrap();
        assert!(!families.is_empty());
        assert!(families.iter().any(|font| font.monospace));
        println!("Enumerated {} system font families", families.len());
    }
}
