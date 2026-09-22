# Commands, shortcuts, and context menus

PiDeck desktop interactions share one command layer in
`apps/desktop/src/lib/commands/`. A command owns its title, optional chord,
availability rule, focus scope, and action. Keyboard shortcuts consume this registry;
the shortcut reference dialog renders the same data. A future command palette must
also consume the registry instead of adding component-local action copies.

## Action ownership

- Host-backed actions such as creating a Session and stopping the current activity
  live in `commands/actions.ts`. They retain Host identity checks and publish their
  own pending state.
- UI-local actions use request buses in `commands/events.ts`. Sidebar, Session search,
  and RightDock subscribe while mounted; Session search queues an intent while the
  collapsed Sidebar has its list unmounted.
- Existing focused actions such as opening the Session tree remain in their feature
  bus and are called by the registry.

## Key dispatch

`CommandLayer` installs one window capture listener. Matching applies these rules in
order:

1. Pass through already-consumed and IME-composition events, including key code 229.
2. Resolve `mod` as Command on macOS and Control elsewhere, with no extra primary
   modifier accepted.
3. Let xterm own keys unless the command explicitly supports terminal focus.
4. Let text fields own unmodified keys. Escape-to-stop is limited to the Composer.
5. Let dialogs, menus, and Composer completion consume Escape before the chat.
6. Check live Zustand state before preventing the browser event and running the
   command.

`mod+K` remains unassigned for a command palette. macOS native menu accelerators must
not duplicate DOM-owned chords; each chord has one owner.

On macOS, the native File → Close Window menu owns `Cmd+W` and calls Tauri's
`close()` on the focused window. The default AppKit close action cannot close
our borderless windows, so it is replaced rather than duplicated in the DOM.
Closing the main
window (including its close button) saves drafts, checks unsaved file edits,
and hides the window without destroying its WebView or stopping the Host and
terminals. The app remains in the Dock; clicking its Dock icon shows and focuses
the existing main window. `Cmd+Q` and Quit still use the separate app-exit path,
including draft persistence, unsaved-file confirmation, and process cleanup.
Detached Extension windows retain their own close handling.

## Shortcut customization

Settings renders editable bindings from the same command registry consumed by the
global dispatcher and shortcut reference dialog. `DesktopSettings.shortcutOverrides`
stores only differences from registry defaults: a canonical chord string overrides a
command, `null` explicitly leaves it unassigned, and a missing key restores its
default. Reset all writes an empty map. Invalid persisted values fall back to the
registry default instead of disabling commands unexpectedly.

Recorder input stores the logical `mod` modifier so one setting remains portable:
it resolves to Command on macOS and Control elsewhere. Letters, digits, and
punctuation require `mod` or Alt; function keys may stand alone. Escape cancels a
recording, Delete or Backspace clears the binding, and Tab leaves the recorder.
Conflicting effective bindings are rejected inline before persistence. While a
recorder owns focus, the global dispatcher passes its key events through so recording
cannot execute the command being entered.

## Context menus

`MenuHost` renders the single open application menu through a portal. It clamps to
the viewport, supports Arrow Up/Down, Home/End, Enter/Space, and Escape, and restores
focus to the trigger for keyboard closure and selection. Opening a menu from another
surface replaces the previous instance and starts a new focus cycle.

The app suppresses the WebView default context menu, except for:

- Tauri drag regions, which retain the platform window menu.
- Shift-right-click in development builds, which retains inspection access.
- The Browser dock surface, which is a separate native child WebView and owns its
  own platform menu.

Generic inputs receive Cut, Copy, Paste, and Select all actions. Feature surfaces add
domain actions without reimplementing menu lifecycle: Session rows, transcript rows,
the Composer, and xterm terminals are the first consumers.

Safe HTTP(S) links in conversation content use an explicit desktop routing policy.
Ordinary activation opens the URL in a Dock browser tab, while system-browser
activation goes through the Tauri shell plugin. A link-specific transcript context
menu offers **Open in Dock**, **Open in external browser**, and **Copy link** before
the normal selection/message actions. Conversation anchors deliberately omit
`target="_blank"` so the shell plugin cannot also auto-open a second external window.

## Extension rules

- Add user-visible labels to both `en.ts` and `zh.ts` in the same change.
- Add a registry command only when an action is useful outside one component.
- Keep dynamic resource actions, such as one Session row, in context-menu item
  builders rather than manufacturing registry entries for every resource.
- Preserve protocol context requirements. For example, Session export is active-
  Session-only, so inactive Session menu entries remain disabled.
- Test chord and focus classification as pure logic; test shared menu behavior in
  jsdom; add a surface-level DOM regression when wiring a new interaction family.
