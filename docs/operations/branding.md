# PiCove branding

PiCove is the new display name of PiDeck. The current development build uses
PiCove in the interface, startup screen, window title, tray and notification copy.
Published v0.3.0 installers still use PiDeck. The Pi mark is retained for this
brand preview.

## Compatibility during the preview

The display-name change deliberately preserves these identities:

- Tauri `identifier`: `com.skitre.pideck`.
- Tauri `productName`: `PiDeck`, including existing installer naming and checks.
- Executable and workspace package names: `pideck.exe` and `@pideck/*`.
- `PIDECK_*` environment variables, `pideck.*` persistence keys and theme IDs.
- Existing application configuration, browser data and `~/.pi/agent/pideck` data.
- Extension contracts, including `opts.pideck` and existing exported type names.
- The updater signing key.
- Existing provider User-Agent compatibility presets.

These are compatibility names, not alternate user-facing brands. Existing
architecture and historical documents may still refer to PiDeck.

## GitHub repository rename

The existing repository was renamed from `Skitre/PiDeck` to `Skitre/PiCove`.
Current README links, release titles, the update manifest generator and the
development updater endpoint use the new repository name. Published v0.3.0
still requests the old updater URL, which relies on GitHub's redirect.
Do not create another repository named `Skitre/PiDeck`, as that would break
the old repository redirect. Historical release assets retain their filenames.

## Before renaming distributed installers

Changing the installer product name is a separate release step. Update the
installer integrity checks, normalized macOS asset names, release titles and
download documentation together. Verify upgrades from the published PiDeck
version on Windows and both macOS architectures, including install location,
shortcuts, application identity, retained settings/sessions and automatic updates.
Do not replace or rename existing published v0.3.0 assets for this preview.
