# Extension Deck — fixed PiDeck shell, global Extension presentation

> **Status: accepted target design (2026-08-22), amended 2026-08-23 by the V2
> amendment below. V1 implemented behind the one-release `extension-deck-v1`
> gate (default on); V2 unbuilt.** This page
> supersedes [Deck](./deck.md) after product review. Deck remains the historical
> record of the rejected whole-window pane alternative and must not be used as
> an implementation specification. This design keeps its Extension UI goals,
> renderer model, and Host-policy boundary while narrowing the shell and
> persistence model.
>
> [Extension UI surfaces](./extension-ui-surfaces.md) remains authoritative for
> the SDK verb inventory. [Extension presentation](./extension-presentation.md)
> remains authoritative for Host routing, risk, and decision policy.
> Current-behavior pages remain factual until a batch lands; for the unbuilt
> target, this page wins over the superseded Deck wherever they conflict.

## Decision in one sentence

PiDeck keeps its current fixed Sidebar, Chat, and RightDock. Extensions get a
host-owned presentation layer consisting of composer anchors, a float layer, a
bounded `Extensions` area inside RightDock, and the Host modal layer. Each
Extension has one global presentation profile shared by every session; moving
an Extension surface edits that global profile.

This is not a session workspace system and not a general-purpose pane manager.

## V2 amendment — detached floats and structured widgets

V1 shipped with two deliberate non-goals: **“OS-level extra windows”** and
**“Inventing interactivity for read-only widget content.”** V2 reverses both,
narrowly. Everything else on the V1 non-goal list stands.

Both reversals are additive. A user who never detaches a float and an Extension
that never publishes a structured payload get V1 behavior unchanged.

### Reversal 1 — a float may leave the main window

|                       |                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1 rationale          | An HTML float layer inside one window avoided native window geometry, per-monitor DPI, cross-window focus, and a second renderer lifecycle. None of that was required to give Extension surfaces a home.                                                                                                                                                                        |
| What changed          | The float layer succeeded at giving Extension content a stable home and then hit the ceiling of one window. A fleet widget or a `custom()` panel is exactly the content a user wants parked on a second monitor while Chat stays on the first. Inside one window a float is also permanently subordinate to the window's own size and to the native Browser rect it must dodge. |
| Scope of the reversal | Only an Extension **float** may become an OS window, and only for the `widget` and `custom` families that could already float. Sidebar, Chat, RightDock, anchors, Settings, and the Host modal layer never leave the main window. Status still cannot float, so it still cannot detach.                                                                                         |

A detached float is the same presentation slot in a different container, not a
second application. See [Float layer](#float-layer) for the state model and
[Detached float windows](#detached-float-windows) for the architecture.

### Reversal 2 — a widget may declare actions

|                       |                                                                                                                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1 rationale          | The SDK's `setWidget` carries `string[]` lines or a `pi-tui` component factory. Neither carries action semantics, so any interactivity would have been invented by PiDeck and attached to content that did not ask for it.                                                                              |
| What changed          | The constraint was never “widgets must be inert” — it was “PiDeck must not guess intent from text.” An Extension that _declares_ its actions is not a guess. PiDeck's own `extensionUi.widgetChanged` already carries `widget: JsonValue`, so a declared payload needs no new event and no SDK release. |
| Scope of the reversal | Only an explicit, versioned, PiDeck-owned **structured payload** carries actions. Plain `string[]` widgets and factory-rendered widgets stay read-only forever; PiDeck never infers a button from a line of text. Extensions still ship semantic data, never HTML, CSS, React, or renderer code.        |

See [Structured widgets](#structured-widgets) for the schema and action channel.

### What did not change

- Host stays authoritative for `presentation`, `risk`, and `routeReason`.
- Presentation profiles stay global per `ExtensionId × family`.
- The app store stays the only writer of `DesktopSettings`.
- Blocking dialogs stay non-draggable, non-dockable, and non-detachable.
- Session switching still loads no layout.

## Why this replaces the broader Deck

The original Deck correctly identified the problem: PiDeck welds each
Extension UI verb to one surface. It went further and made every builtin panel
part of a movable whole-window layout. Product review found no need for that
second step.

Files, session tree, Git changes, shells, browsers, the session list, and Chat
already have understandable homes. Making them draggable, splittable, and
floatable would add migration risk, layout persistence, focus states, native
webview geometry, and user-facing freedom without solving the Extension UI
problem.

Session-specific or workspace-specific layouts also work against fast,
predictable session switching. Switching already performs runtime hydration,
Extension state replay, epoch alignment, and `custom()` disposal. It must not
also load and reconcile a different pane tree, restore per-session geometry,
or visibly move the same Extension between locations.

The replacement therefore separates three lifetimes:

| Concern                        | Scope                    | Meaning                                                                       |
| ------------------------------ | ------------------------ | ----------------------------------------------------------------------------- |
| PiDeck application shell       | app implementation       | Sidebar, Chat, and RightDock keep their fixed roles                           |
| Extension presentation profile | global DesktopSettings   | where one Extension family always appears, across every workspace and session |
| Extension UI content           | active session / request | the live widget, status, `custom()`, or blocking-dialog data                  |

**Sessions decide what content exists. Global Extension settings decide where
that content appears.**

## End state in one scenario

`pi-subagents`, unmodified, has been observed using widget, status, `custom()`,
and blocking-dialog surfaces. Settings therefore shows four presentation
rows for that Extension.

The user configures its widget as a pinned top-right float, status above the
composer, `custom()` UI in the RightDock `Extensions` area, and low-risk
blocking dialogs inline. Every session uses those choices. When a session has
no fleet widget, the float shell is absent. When another session publishes the
same family, its content appears in the same top-right float without restoring
a session layout.

The user drags FleetView into the Dock. On pointer-up it enters the Extensions
area and PiDeck saves `pi-subagents.widget.home = "dock"`. A toast says that the
change applies to every session and offers Undo. Future sessions use the Dock.
No per-session override is created.

A high-risk confirm still takes the Host modal layer. It is not represented in
the profile and cannot be dragged, docked, hidden, or rerouted.

## Fixed application shell

The existing window structure remains product-owned and non-recomposable:

```text
┌────────────────┬────────────────────────────┬──────────────────────┐
│ Sidebar        │ Chat                       │ RightDock            │
│ sessions       │ transcript                 │ Files                │
│ fixed          │ composer + anchors         │ Tree                 │
│                │ fixed                      │ Git                  │
│                │                            │ Shell                │
│                │ Extension floats may       │ Web                  │
│                │ appear over HTML areas     │ Extensions (dynamic) │
└────────────────┴────────────────────────────┴──────────────────────┘
                         < Host modal layer >
```

| Shell surface                    | Decision                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------ |
| `Sidebar` / sessions             | kept as-is; not a View, not movable, not floatable                                         |
| Chat                             | kept as-is; single active session, never split or moved                                    |
| Files / Tree / Git / Shell / Web | kept as existing RightDock tabs; never moved, floated, or split                            |
| RightDock                        | kept as the fixed, collapsible right rail with its existing width preference and shortcuts |
| Settings                         | remains a full-window overlay page                                                         |
| Extension anchors                | named slots owned by Chat                                                                  |
| Extension floats                 | HTML layer owned by the Extension Deck; a float may also detach to its own window          |
| Extension Dock                   | bounded layout inside a dynamic RightDock `Extensions` tab                                 |
| Host modal layer                 | authoritative non-movable presentation for policy-routed requests                          |

There are no `left` / `main` / `right` Deck regions, no builtin `PaneNode`s,
and no drop targets on Chat, Sidebar, or builtin RightDock tabs.

The main window remains the whole application: it holds every builtin surface,
the only Chat session, the only Host client, and the only settings writer. A
detached Extension float is the single exception to “one window,” and it carries
no application shell of its own — see [Float layer](#float-layer).

## Vocabulary

| Term                 | Meaning                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| Extension Deck       | The Extension-only presentation layer: anchors, floats, Extensions Dock, and modal handoff               |
| Extension identity   | Stable package/provider identity derived from trusted event origin                                       |
| Surface family       | `widget`, `status`, `custom`, or `blockingDialog`                                                        |
| Presentation slot    | One host shell for an Extension identity + surface family; it may contain several live content instances |
| Presentation profile | Global user preference for one Extension's supported surface families                                    |
| Anchor               | `aboveComposer` or `belowComposer` inside Chat                                                           |
| Extensions Dock      | The dynamic RightDock tab that hosts only Extension presentation slots                                   |
| Float                | A movable, resizable HTML shell for an Extension slot                                                    |
| Attached float       | A float rendered in the main window's HTML float layer — the only V1 form                                |
| Detached float       | The same float slot hosted in its own OS window, positioned in screen coordinates                        |
| Structured widget    | A widget payload matching PiDeck's declared schema, rendered as host-owned controls instead of text      |
| Observed capability  | A surface family Desktop has learned from a validated, trusted-origin Host event                         |

## Extension surface model

Only Extension UI participates. Builtins are deliberately outside this model.

| Family                         | Live cardinality        | Allowed user presentation                                                         | Content lifetime                                                      |
| ------------------------------ | ----------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `widget`                       | many keys per Extension | follow Extension placement, above/below composer, Extensions Dock, float, hidden  | active session; ends on `setWidget(key, undefined)` or session switch |
| `status`                       | aggregate per Extension | above composer, Extensions Dock, hidden                                           | active session; follows published status content                      |
| `custom`                       | ≤ 1 active `custom()`   | follow Extension `overlay`, Extensions Dock, or float                             | active session; ends on `done()`, cancel, or session switch           |
| `blockingDialog`               | ≤ 1 active + queue      | follow Host, Chat inline, or modal; user choice applies to low-risk requests only | request lifecycle                                                     |
| high-risk / lifecycle decision | ≤ 1 active + queue      | Host modal only; not configurable                                                 | request lifecycle                                                     |

Notifications are not surfaces. `notify` remains a transient signal handled by
the existing toast stack and notification center.

Only widget and `custom()` slots are draggable. Status placement changes
through Settings or Dock tab ordering; it never becomes a standalone float.
Blocking dialogs are never draggable and cannot enter Extensions Dock, Float,
or hidden state.

Detaching a float to its own window is available to exactly the families that
may float — widget and `custom()` — because it selects a container for an
existing float, not a new presentation. A family that cannot float cannot
detach, so status and blocking dialogs stay inside the main window by the same
rule that already governs them.

### Verb-by-verb presentation policy

The settings surface follows the real SDK verb inventory rather than giving
every verb a generic placement picker.

#### Blocking dialogs: `select`, `confirm`, `input`, `editor`

The four request/response dialogs share one per-Extension **Blocking requests**
preference:

```text
Follow Host policy (default) | Inline in Chat | Modal
```

The preference only applies when Host policy permits. High-risk and
session-lifecycle requests remain modal regardless of user selection. Dialogs
never enter Dock, Float, Anchor, or hidden state: the Extension is waiting for a
result, so the request must remain discoverable and reachable.

The four methods retain their Host-owned controls (`select` list, `confirm`
buttons, single-line `input`, multi-line `editor`). V1 does not add four
separate placement settings. `editor` may still be promoted to modal by Host
policy when its content or viewport requirements make inline presentation
unsound.

#### `notify`

`notify` has no placement setting. It remains transient toast / notification
center content. A future per-Extension mute or severity filter belongs to
notification policy, not Extension Deck.

#### `setStatus`

Status is compact, passive chrome. Legal global homes are:

```text
Above composer (default) | Extensions Dock primary/secondary | Hidden
```

Status never becomes a standalone Float and never uses the below-composer
slot. Multiple status keys from one Extension aggregate into one status slot.
If configured in Dock, appearance is passive and does not steal the active
RightDock tab.

#### `setWidget`

Widget is persistent, read-only summary content and has the broadest legal
placement set:

```text
Follow Extension placement (default)
Above composer
Below composer
Extensions Dock primary/secondary
Floating panel
Hidden
```

“Follow Extension” preserves each live key's `aboveEditor` / `belowEditor`
hint, so one Extension may contribute to both anchor aggregates without gaining
per-key layout memory. A forced Anchor, Dock, Float, or Hidden choice applies to
all widget keys from that Extension. In Dock/Float they share one host shell and
render as bounded rows, sections, or tabs.

Widget content remains non-interactive. A factory snapshot does not gain focus,
keyboard input, or mini-TUI behavior because it is movable. Real input remains
the responsibility of dialogs, `custom()`, commands, and shortcuts.

#### `custom(factory, options?)`

`custom()` is focused interactive content. Legal global choices are:

```text
Follow Extension (default) | Extensions Dock primary/secondary | Floating panel
```

When following the Extension, `overlay: true` defaults to a centered Float;
absent/false `overlay` defaults to Extensions Dock primary. An explicit user
choice overrides that hint. `custom()` cannot be Inline, anchored, or hidden,
because the Extension waits for `done()` and input/resize must remain reachable.

A Docked `custom()` automatically opens RightDock and activates Extensions. A
floating `custom()` receives focus. Ending or cancelling it restores the prior
stable focus through the existing ownership checks.

#### Fixed and unsupported verbs

The remaining SDK UI methods do not receive presentation settings:

| Verb class                                                                                                               | Policy                                                                            |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `setTitle`                                                                                                               | remains no-op until PiDeck defines which Host title it may change                 |
| `setWorkingMessage`, `setWorkingVisible`, `setWorkingIndicator`, `setHiddenThinkingLabel`                                | remain no-op; PiDeck owns streaming/loader chrome                                 |
| editor/TUI chrome (`setEditorText`, `setEditorComponent`, `setFooter`, `setHeader`, theme APIs, `onTerminalInput`, etc.) | retain existing stub/no-op behavior; Extensions do not replace application chrome |
| custom messages and registered renderer snapshots                                                                        | remain transcript-owned and immovable                                             |
| registered commands and shortcuts                                                                                        | remain in the command registry; they are not presentation surfaces                |

These verbs are not added to observed presentation capabilities. Supporting
one later requires a separate Host semantic contract, not merely adding another
home value.

### Presentation slots, not per-session panes

The persisted unit is an Extension family slot, not a live widget key or
request id:

```text
pi-subagents + widget          → one global widget presentation slot
pi-subagents + status          → one global status presentation slot
pi-subagents + custom          → one global custom UI presentation slot
pi-subagents + blockingDialog  → one global blocking-dialog preference
```

Several widget keys from the same Extension share the widget slot. The selected
renderer presents them as bounded rows, sections, or tabs; it does not create
independently remembered floats. Status content is similarly aggregated by
Extension identity. `custom()` is already singleton, and sequential blocking
dialogs reuse the existing group/queue shell.

This family-level granularity is intentional. It gives one stable setting users
can understand and prevents an unbounded collection of stale `ViewKey` layout
memory. A future per-key override requires a demonstrated product need, a
stable SDK key, and a separate design review; it is not an implementation seam
to fill speculatively.

### Identity and protocol

Profiles key on a stable `ExtensionId` derived from trusted origin. Derivation
uses package/provider identity and excludes invocation ids, request ids, epochs,
session ids, and other per-run values. Legacy events without origin use their
existing collision-prone fallback and cannot receive reliable per-Extension
settings until origin is available.

The event contract adds two optional fields across three existing payloads:

```ts
type ExtensionUiEventOrigin = NonNullable<ExtensionUiRequest["origin"]>;

type ExtensionUiStatusChanged = {
  key?: string;
  text: string;
  origin?: ExtensionUiEventOrigin;
};

type ExtensionUiWidgetChanged = {
  key?: string;
  widget: JsonValue;
  placement?: "aboveEditor" | "belowEditor";
  origin?: ExtensionUiEventOrigin;
};

type ExtensionUiCustomStarted = {
  requestId: string;
  title?: string;
  cols: number;
  rows: number;
  origin?: ExtensionUiEventOrigin;
  overlay?: boolean;
};
```

`origin` uses the exact trusted `ExtensionUiRequest["origin"]` union; it is not a
second identity shape. Host attaches it to every `widgetChanged` and
`statusChanged` event (including clears), and every `customStarted`, whenever a
trusted active invocation is known. For callbacks outside an invocation, the
binding layer supplies a trusted package identity as a known `background`
origin when available. It must
never infer identity from widget keys, titles, labels, terminal content, or
package-like strings. A missing or `unknown` origin remains legal for wire
compatibility, renders with existing defaults, and cannot create a reliable
per-Extension profile.

Origin is captured when the public SDK mutation/start call is made (or when a
widget factory is registered), then carried through deferred factory renders,
frame buffering, queued delivery, and replay. Those later stages must not query
whatever invocation happens to be active at replay time. A clear event reuses
the trusted origin associated with the live key when the current call has no
stronger known origin.

`overlay` is copied from the Extension's `custom()` options. It selects the
default only when the user has no custom UI preference or explicitly chooses
“Follow Extension.” `false` and absence both mean the existing Dock default.

The changed event payloads must be represented in
`packages/protocol/src/contracts.ts`, exported types, exact runtime validators,
DTO validation tests, and protocol-coverage tests. Host emit-site tests cover
active-invocation origin, trusted package fallback, legacy/unknown fallback,
replay of widget/status origin, and both values of `customStarted.overlay`.

No session or workspace identifier participates in presentation identity.

## Observed capabilities and Settings UI

Extensions do not currently declare their UI verb inventory in a manifest, and
the design does not statically scan package source. Host only attaches trusted
origin; it does not own or persist a capability catalog. Desktop event ingestion
records surface families it has observed each Extension use:

```ts
type ExtensionSurfaceFamily = "widget" | "status" | "custom" | "blockingDialog";

type ObservedExtensionUiCapabilities = Record<
  ExtensionId,
  {
    families: ExtensionSurfaceFamily[];
    lastSeenAt: number;
    displayName?: string;
  }
>;
```

The observation mapping is exact:

| Validated event                                                 | Observed family  |
| --------------------------------------------------------------- | ---------------- |
| non-null `extensionUi.widgetChanged` with known trusted origin  | `widget`         |
| non-empty `extensionUi.statusChanged` with known trusted origin | `status`         |
| `extensionUi.customStarted` with known trusted origin           | `custom`         |
| `extensionUi.request` with known trusted origin                 | `blockingDialog` |

Desktop merges the family into the global catalog before rendering. Only the
first observation of an Extension/family pair, or the first trusted
`extensionDisplayName` for that Extension, changes the store and schedules
one atomic settings write; repeated events and widget/status replay are
idempotent and do not write again. Filling a missing `displayName` does not
change `lastSeenAt` or the family list. Clearing/closing events do not remove an
observation. Originless or `unknown` legacy events render with defaults but do
not create profiles or settings rows. Notification, no-op chrome, transcript
renderer, custom-message, command, and shortcut events are never observed as
presentation capabilities. Observation is global metadata, not session content.
`displayName` is a Settings/chrome label only; it is not presentation identity.

Settings shows one **UI presentation** section per observed Extension. It only
offers presentation choices legal for that family:

```text
pi-subagents

Widget
  Show in       [Floating panel      ▾]
  Pin           [On]

Status
  Show in       [Above composer      ▾]

Custom UI
  Show in       [Extensions Dock     ▾]
  Dock group    [Primary             ▾]

Blocking requests
  Show in       [Follow Host policy  ▾]

High-risk requests
  Host policy   Modal — cannot be changed

  [Reset Extension UI defaults]
```

| Family                         | Legal setting values                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| `widget`                       | follow Extension placement, above/below composer, Dock primary/secondary, float, hidden |
| `status`                       | above composer, Dock primary/secondary, hidden                                          |
| `custom`                       | follow Extension `overlay`, Dock primary/secondary, or float                            |
| `blockingDialog`               | follow Host policy, Chat inline, or modal; applies only when Host policy permits        |
| high-risk / lifecycle decision | displayed as locked Host policy, never stored as a preference                           |

Changing Settings rehomes a currently live widget, status, or custom slot
immediately and persists the same choice for every future session. A blocking
preference is synchronized to Host and applies to subsequently routed requests;
Desktop never moves an already-published Host-final request on its own.

## Global presentation profile

The source of truth lives in global DesktopSettings, not in project workspace
state and never in a session transcript:

```ts
type SurfaceRef = `${ExtensionId}:${ExtensionSurfaceFamily}`;
type DockGroupId = "primary" | "secondary";

type NormalizedFloatRect = {
  x: number; // 0..1 within the HTML workspace bounds
  y: number; // 0..1
  width: number; // CSS px, clamped on restore
  height: number; // CSS px, clamped on restore
};

type PresentationHome =
  | { kind: "followExtension" }
  | { kind: "followHost" }
  | { kind: "anchor"; slot: "aboveComposer" | "belowComposer" }
  | { kind: "dock"; group: DockGroupId; order: number }
  | { kind: "float"; rect: NormalizedFloatRect; pinned?: boolean }
  | { kind: "inline" }
  | { kind: "modal" }
  | { kind: "hidden" };

type PresentationPreference = {
  home: PresentationHome;
};

type ExtensionPresentationProfile = Partial<Record<ExtensionSurfaceFamily, PresentationPreference>>;

type ExtensionDockSettings = {
  direction: "row" | "column";
  secondaryEnabled: boolean;
  sizes?: [number, number];
};

type ExtensionUiSettings = {
  version: 1;
  presentations: Record<ExtensionId, ExtensionPresentationProfile>;
  dock: ExtensionDockSettings;
  observedCapabilities: ObservedExtensionUiCapabilities;
};
```

V1 resource limits are shared protocol constants in
`packages/protocol/src/limits.ts` and mirrored in Rust:

```ts
MAX_EXTENSION_UI_IDENTITIES = 256;
MAX_EXTENSION_UI_EXTENSION_ID_LENGTH = 256;
MAX_EXTENSION_UI_DISPLAY_NAME_LENGTH = 120;
MAX_EXTENSION_UI_SETTINGS_BYTES = 262_144; // UTF-8 JSON bytes of extensionUi
MAX_EXTENSION_UI_FLOATS = 8;
```

An Extension ID is a non-empty bounded opaque string. Family arrays are unique
and limited to the four known values; `lastSeenAt` is a non-negative safe
integer. Optional `displayName` is a non-empty string of at most 120
characters from the last trusted origin. Dock `order` is an integer from 0 through 255. Both Dock sizes are
finite fractions from 0.2 through 0.8 and are normalized to sum to 1. Float
coordinates are finite normalized values from 0 through 1; width and height are
finite positive CSS pixels and are viewport-clamped before mount. Counts and
UTF-8 size are checked before state mutation or renderer creation.

The profile home is canonical. Dock tab order is derived by sorting the
profiles assigned to each group; it is not duplicated as another persisted
array. Runtime state may cache the result but must not write a second
representation.

Float position belongs to the family profile. `x` / `y` are normalized so a
setting survives window-size changes; width and height retain useful pixel
intent and are clamped to the current bounds. Float z-order is ephemeral. Pin,
size, and the final pointer-up rect are global.

V1 has no project override. If a workspace override is ever added, it must be
an explicit later precedence layer with visible Settings UI, not an accidental
side effect of moving a surface.

### Resolution precedence

Widget, status, and `custom()` events resolve through one pure Desktop
presentation resolver:

1. **Family legality.** Illegal homes and Float/resource limits cannot be
   selected.
2. **Global user profile.** A valid saved preference selects the legal
   presentation mode/home.
3. **Extension / Host hint.** `aboveEditor` / `belowEditor`, custom `overlay`,
   or the family default picks the result when the profile is absent or
   explicitly says to follow the Extension.
4. **PiDeck default.** Final safe family fallback.

Blocking dialogs do not run through that Desktop resolver. Desktop projects the
global `blockingDialog` preferences into `extensionUi.configure`; Host applies
ownership and mandatory policy first, resolves the per-Extension override, and
publishes final `presentation`, `risk`, and `routeReason`. Desktop mounts that
final result without downgrade. See
[Extension presentation](./extension-presentation.md#host-routing-modes).

User profiles may only choose values legal for their family. Corrupt, unknown,
or now-illegal values fall through to the next level and are repaired on the
next settings write.

Default mapping:

| Family                             | No-profile default                                                          |
| ---------------------------------- | --------------------------------------------------------------------------- |
| widget                             | follow `aboveEditor` / `belowEditor`; unknown placement uses above composer |
| status                             | above-composer anchor, `strip` renderer                                     |
| custom with `overlay: true`        | centered float                                                              |
| custom with absent/false `overlay` | Extensions Dock primary group                                               |
| low-risk blocking dialog           | follow Host inline/modal presentation                                       |
| Host-routed modal decision         | modal layer                                                                 |

Resetting one family deletes its preference and immediately re-resolves from
the Extension hint and Host default. Resetting an Extension deletes all of its
family preferences but keeps observed capability rows.

## Dragging edits global Settings

There is no “current session layout edit.” Every permitted move changes the
global presentation profile:

```text
drag pi-subagents Widget from float to Dock primary
                        ↓
move the live slot
                        ↓
save presentations[pi-subagents].widget.home
                        ↓
all sessions and workspaces now use Dock primary
```

The save occurs on a completed drop or resize, not every pointer move. The UI
then shows a non-blocking toast:

```text
pi-subagents Widget now opens in Extensions Dock
Applies to all sessions · Undo
```

Undo restores the previous global preference and rehomes the live slot. The
same behavior applies to Settings changes, Dock tab reorder, Dock group moves,
float pin, and float resize.

Moving one family does not move another family from the same Extension. Moving
`pi-subagents.widget` changes all live widget keys in its aggregate slot, but
does not affect its status, custom UI, or blocking-dialog preferences. Only
widget and `custom()` surfaces expose free drag; status and blocking-dialog
placement changes use their legal Settings controls.

## Composer anchors

Chat exposes two Extension chrome anchors:

- `aboveComposer`
- `belowComposer`

Chat also retains its fixed `requestFlow` mount for inline blocking dialogs; it
is selected by dialog policy, not treated as a draggable Anchor.

Anchored surfaces have bounded height and an expand affordance. Widget placement
hints select the first-use anchor, preserving TUI intent. Promoting an anchored
widget slot to Dock or Float writes the global family preference. Returning it
to an anchor does the same.

The current widget popover drawer is removed. It was a PiDeck surface mapping,
not an SDK contract.

Anchor order is deterministic by Extension identity and family; V1 does not
support free per-session reordering. If order becomes a product need, it is a
global Settings field.

## RightDock Extensions area

`RightDock` and its existing builtin tabs remain authoritative. One dynamic tab
is added:

```text
Files | Tree | Git | Shell | Web | Extensions
```

The `Extensions` tab is visible only while at least one live surface resolves to
Dock. Its configured group and order remain in global Settings while content is
absent; no empty tab is shown during a session that has no docked Extension UI.

Inside `Extensions`, layout is deliberately bounded:

- One primary tabs group always exists while the area is active.
- One optional secondary tabs group may appear.
- The two groups may be `row` or `column` and have one persisted size ratio.
- A group contains Extension presentation slots only.
- Center drop inserts/reorders a tab in a group.
- Edge drop enables or targets the secondary group.
- Once two groups exist, no drop target creates a third group or recursive
  split.
- Empty secondary collapses; empty primary promotes secondary to primary.
- Files, Tree, Git, Shell, and Web never appear in either group and never show
  split or float affordances.

```text
Extensions — one group
┌────────────────────────────────────┐
│ FleetView | Status | Inspector     │
└────────────────────────────────────┘

Extensions — bounded two-group layout
┌──────────────────┬─────────────────┐
│ FleetView        │ Status          │
│                  │                 │
│                  ├ tabs: A | B     │
└──────────────────┴─────────────────┘
```

This is not a recursive `SplitNode | TabsNode | PaneNode` tree. The bounded
shape is easier to validate, explain in Settings, restore globally, and leave
mounted across session switches.

`dock.activate.N`, current Dock width/open state, and `mod+j` retain their
existing meaning. When the Extensions tab is active, tab navigation inside its
focused group uses Extension-specific commands rather than generalizing the
entire RightDock into a pane system.

### Migration from today's custom terminal tabs

Today `RightDock.tsx` models each live `custom()` panel as
`extension:${requestId}` through `extensionTabId(requestId)`. The target
does not keep that identity as a top-level Dock tab: it adds one stable
`"extensions"` `DockTabId`, and the bounded layout inside that tab hosts
presentation slots keyed by `${ExtensionId}:custom`.

The cutover ships for one release behind the internal rollout gate
`extension-deck-v1`:

| Gate | Active path                                                                   |
| ---- | ----------------------------------------------------------------------------- |
| off  | current `extension:${requestId}` top-level tabs and `ExtensionTerminal` mount |
| on   | one `extensions` top-level tab and Extension-family slots inside it           |

During that release the TypeScript `DockTabId` union may contain both
`"extensions"` and `extension:${string}`, solely so both gated branches
compile. Runtime tab construction is still exclusive. Removing the gate also
removes the template-literal member and `extensionTabId()`.

The paths are mutually exclusive for a running Desktop. A `customStarted` event
must enter exactly one path; it must never create both a legacy top-level tab
and a new slot. The gate is read once before Dock state initializes and is not a
user layout preference. Tests run the same start/frame/input/resize/close
lifecycle in both modes during the compatibility release.

In the new path, live terminal content and transport remain keyed by the
session identity plus `requestId`; `customFrame`, `customInput`,
`customResize`, and `customClosed` continue using that request identity. Only
the presentation shell is keyed by `ExtensionId:custom`. `customClosed` removes
the request-to-slot content binding and releases renderer resources, but never
deletes the global profile, Dock group/order, or observed capability.

Turning the gate off restores the current per-request tabs without migrating or
deleting global Extension profiles; those profiles are simply ignored by the
legacy path and remain available when the gate is enabled again. Rollback must
not touch builtin tab order, active builtin tab, Dock width/open preferences,
or shortcuts. After one green release and explicit removal review, delete the
legacy `extension:${requestId}` branch and the gate together—do not leave two
permanent representations.

## Float layer

An Extension widget or `custom()` family may resolve to one float shell. Status
and blocking dialogs cannot. The shell hosts the family's live aggregate content
and uses a compatible Host renderer.

A float shell is in one of two **containers**. The container is a property of
the same `float` home, not a separate presentation choice: the family policy,
the Settings row, the drag rules, and the float cap are identical in both.

| Container | Where it lives                                                     | Geometry                                         | Stacking                                           |
| --------- | ------------------------------------------------------------------ | ------------------------------------------------ | -------------------------------------------------- |
| Attached  | HTML float layer in the main window (V1 behavior, and the default) | viewport-normalized rect                         | z-order within the float layer                     |
| Detached  | Its own OS window                                                  | logical screen coordinates plus monitor identity | OS window order; `pinned` becomes OS always-on-top |

Floats support:

- title-bar drag and edge resize;
- viewport clamp and snapping (attached) or monitor clamp (detached);
- optional pin;
- Dock drop target;
- return-to-anchor for widget;
- tear-off to a detached window and re-attach by dragging back over the main
  window;
- focus restoration on hide/close;
- labelled non-modal dialog semantics;
- reduced-motion behavior.

At most eight Extension float shells may be live, **counting attached and
detached together** — detaching moves a shell, it does not create one. Settings
prevents creating a ninth; corrupt overflow falls back to Extensions Dock
primary. The limit is on live shells, not on observed Extensions.

A slot shell exists only while matching session content exists. When content
ends, the shell hides — a detached window is destroyed — and releases renderer
resources. Its global preference, including its container and placement,
remains. Reappearance recreates the shell in the same container at the same
global placement; it does not restore session state.

Closing a float invokes the family-correct action:

- widget may be globally set to `hidden` after explicit user choice;
- `custom()` close sends cancel / `done()` through existing ownership checks.

Removing DOM must never leave a still-live `custom()` request with no reachable
surface. Destroying a detached window carries the same obligation: the slot
must re-resolve to a reachable container before its window goes away.

### Detached float windows

A detached float is a **thin client**. The main window remains the only Host
client and the only writer of `DesktopSettings`; the float window renders one
slot and reports user intent back.

| Concern        | Rule                                                                                                                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window         | One Tauri window per detached slot, undecorated, labelled from the slot id, loading the same frontend bundle under a `surface=float` entry point that mounts a float root instead of the application shell |
| Host transport | The float window never subscribes to the Host event stream and never sends a Host request. It has no session, workspace, or agent state                                                                    |
| Content        | The main window forwards that slot's resolved mount payload — widget rows, status rows, or the `custom()` frame stream — over an app-level event addressed to the window                                   |
| Intent         | The float window reports close, pin, geometry commit, `custom()` input/resize, and widget actions back to the main window, which performs the Host request and the settings write                          |
| Chrome         | Theme, language, reduced-motion, and label text are forwarded with the content so the float never reads settings independently                                                                             |
| Lifetime       | Bounded by the main window. Main window close, Host restart, and app update destroy every float window first. On boot the main window destroys orphans before restoring any placement                      |

This preserves every V1 invariant that depended on there being one store: one
canonical settings value, one serialized write queue, one observation path, and
one `extensionUi.configure` projection. A second full application instance is
rejected for the opposite reason — it would duplicate session restore, the
event stream, and the settings writer, and reintroduce write races the V1
contract spent real effort eliminating.

### Tear-off and re-attach

Both directions are one pointer gesture, and both are driven by the window that
owns the pointer. The gesture never hands off to a native window drag loop,
because during a native drag the application receives no pointer movement and
therefore cannot hit-test drop targets or highlight drop zones.

1. **Tear-off.** Dragging an attached float's title bar keeps pointer capture in
   the main window, which continues to receive movement past its own bounds.
   Crossing the main window's outer bounds by a threshold creates the detached
   window, which then tracks the pointer until release.
2. **Re-attach.** A detached float's title-bar drag positions its own window and
   reports its screen rect to the main window, which hit-tests the existing
   Dock, anchor, and float-layer drop targets and highlights them exactly as an
   in-window drag does. Releasing over a legal target re-attaches the slot.
3. **Escape** cancels either direction and restores the pre-drag container and
   placement, matching the existing in-window drag.

Screen-coordinate conversion, monitor selection, bounds hit-testing, and
placement recovery live in pure modules with unit tests, so the only untested
surface is the thin platform call that moves a window.

### Detached placement and monitor recovery

Detached placement is stored in logical screen coordinates together with enough
monitor identity to validate it later:

```ts
type DetachedFloatPlacement = {
  monitor: { name?: string; position: Point; size: Size; scaleFactor: number };
  rect: Rect; // logical screen coordinates
};
```

On load, placement is matched against the current monitor set by name first and
by position/size second. An unmatched placement **reattaches the slot to the
main window** at its stored normalized rect. PiDeck never spawns a window onto a
monitor that is not currently present, and never silently clamps a float onto a
different monitor than the user chose. Monitor changes while running follow the
same rule.

## Decisions and policy

The Host remains authoritative for `presentation`, `risk`, and `routeReason` as
defined by [Extension presentation](./extension-presentation.md).

- `presentation: "modal"` mounts in the Host modal layer. It is focus-trapped,
  non-draggable, non-dockable, not hidden, and absent from user preferences.
- `presentation: "inline"` mounts in Chat `requestFlow` when the Extension
  profile follows Host policy.
- A low-risk Extension profile may force `inline` or request `modal`; it cannot
  select Dock, Float, Anchor, or hidden. Host risk/lifecycle policy can always
  promote the result to modal.
- Request presentation never keys on `requestId`; sequential questions reuse
  the existing group/queue card shell.

Group continuity, composer blocking through group intervals, expiry-driven
queue advance, ownership and epoch guards, and the respond lifecycle remain
unchanged. Presentation settings choose only between the existing inline and
modal mounts when Host policy permits.

## Renderer registry

Rendering remains Host-owned. Extensions provide semantic data, not HTML,
React, or CSS.

| Family          | Initial renderers              | Notes                                                                                                                                                       |
| --------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| widget          | `strip`, `panel`, `structured` | Home selects the compatible form: anchors stay compact; Dock/Float use panel presentation. A declared structured payload selects `structured` in every home |
| status          | `strip`, `list`                | anchored default stays compact                                                                                                                              |
| custom          | `xterm`; later `structured`    | unknown `pi-tui` trees remain xterm                                                                                                                         |
| blocking dialog | `card`                         | inline and Modal reuse one Host-owned control shell per method                                                                                              |

V1 derives renderer form from family and home rather than exposing an
independent renderer picker for every plugin. A later renderer preference may
be added only where more than one compatible form has a clear user-facing
meaning. Illegal combinations fall back through the presentation resolver.

Content matching `^PI_SUBAGENT_.*_JSON:` uses the temporary non-visual
compatibility renderer that fixes the existing raw transport-line bug. Content
sniffing is not a general renderer contract; replacing it with explicit
transport metadata or bridge-side suppression requires a separately reviewed
protocol change.

### Structured widgets

The `structured` widget form is selected by the payload, not by the home. It is
the only widget content that carries actions.

`extensionUi.widgetChanged` already carries `widget: JsonValue`, so a structured
payload needs no new event, no SDK release, and no change to how a widget is
published, aggregated into a slot, or placed. An Extension opts in by publishing
a payload that matches the declared discriminator and schema version:

```ts
type StructuredWidget = {
  pideck: 1; // discriminator and schema version
  rows: WidgetRow[];
};

type WidgetRow =
  | { kind: "text"; text: string; tone?: "default" | "muted" | "warning" | "danger" }
  | { kind: "fields"; fields: { label: string; value: string }[] }
  | { kind: "progress"; value: number; max: number; label?: string }
  | { kind: "actions"; actions: WidgetAction[] };

type WidgetAction = {
  id: string;
  label: string;
  style?: "default" | "primary" | "danger";
  confirm?: string; // host-rendered confirmation before dispatch
  disabled?: boolean;
};
```

Anything that does not match — including a payload with an unknown `pideck`
version — renders through the existing read-only text renderers. This is a
fallback, never an error: a widget published for a newer PiDeck still shows its
content.

The row vocabulary is intentionally output-shaped plus one action row. Free-form
text entry, selection, and multi-step forms are not in this schema; blocking
dialogs and `custom()` already own those interactions and stay the right answer
for them.

Extensions still ship semantic data only. `rows` describes meaning; PiDeck owns
every control, style, focus ring, and accessible name. There is no path for an
Extension to ship HTML, CSS, React, or renderer code.

### Widget action channel

An action dispatches through a new Host method alongside the existing
`custom()` input path, carrying the same session-target context and the same
ownership and epoch guards:

```ts
"extensionUi.widgetAction": { key: string; actionId: string };
// result: { accepted: true }
```

The bridge delivers it to a handler the Extension registered for that widget
key. PiDeck's bridge already constructs the entire `ExtensionUIContext` object
handed to Extensions — `onTerminalInput` is a bridge-owned stub today — so this
registration is a bridge addition, not an upstream SDK dependency. The
type-level declaration follows the existing SDK patch.

Mandatory guards, all mirroring `extensionUi.customInput`:

- the action is delivered only to the trusted origin that published that key;
- a key with no live widget, no registered handler, or an unknown `actionId`
  is rejected rather than queued;
- session switch and epoch advance invalidate pending actions;
- payload counts, identifier lengths, label lengths, and serialized size are
  bounded by the same validator layer as the rest of the Extension UI protocol;
- a handler that throws produces a diagnostic and leaves the widget published.

An action never implies a transcript entry, a prompt, or an agent turn. An
Extension that wants those effects performs them itself inside its handler.

## Session switching

The fixed shell, anchor hosts, RightDock, Extensions group containers, and
global settings store do not change when the active session changes.

Switch sequence:

1. Existing session/epoch guards begin the switch and stop accepting stale
   Extension input.
2. Session-scoped widget, status, `custom()`, and blocking-dialog instances are
   ended or disposed according to current SDK semantics.
3. Presentation slots lose their content. Empty Float shells hide and the
   Extensions tab hides if no docked content remains. No layout preference is
   deleted.
4. The new session hydrates and the Extension bridge replays its current state.
5. Each event resolves through `ExtensionId × family` using the same global
   profile.
6. Matching slots receive new content; their host position does not require a
   session layout load or tree reconciliation.

```text
Session A: pi-subagents.widget → global top-right float
switch
Session A content disposed; float hidden
Session B replay: pi-subagents.widget → same global top-right float
```

The design does not promise that `custom()` DOM, VirtualTerminal state, or its
underlying interaction survives a session switch. `custom()` remains
session-owned and is disposed. Only its future presentation choice survives.

Acceptance instrumentation must show that a session switch performs no
DeckLayout read/write, no builtin shell remount, and no recursive layout-tree
normalization. The remaining cost is the content lifecycle PiDeck already owns.

## Persistence and recovery

`ExtensionUiSettings` lives in global DesktopSettings. It is schema-versioned
and shared across all project workspaces and sessions for the installation.

### Cross-layer settings contract

This is one persisted `extensionUi` field, not a frontend-only store and not a
second settings file:

```ts
type DesktopSettings = ExistingDesktopSettings & {
  extensionUi?: ExtensionUiSettings; // missing legacy field resolves to v1 defaults
};
```

The implementation batch is incomplete until the field crosses every existing
settings boundary:

| Boundary                                                                    | Required change                                                                                                              |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `packages/protocol/src/types.ts`                                            | export all Extension Deck settings types and add `DesktopSettings.extensionUi`                                               |
| `packages/protocol/src/validate.ts`, `dto-validate.ts`, and protocol tests  | exact keys, enums, numeric bounds, entry/count/string/serialized-size limits, and invalid/corrupt cases                      |
| `apps/desktop/src/lib/desktop-settings.ts` and tests                        | add `extensionUi` to the strict client whitelist and validate snapshots/patches                                              |
| `apps/desktop/src/lib/stores/app-store.ts` and tests                        | hydrate one canonical global value and expose serialized functional updates                                                  |
| `apps/desktop/src-tauri/src/desktop_settings.rs` and tests                  | mirror structs/defaults, top-level patch allowlist, nested validation/repair, persistence, legacy load, and corrupt recovery |
| `apps/desktop/src/features/settings/SettingsPage.tsx` and focused DOM tests | render only observed families and only their legal values                                                                    |

Rust uses `#[serde(default)]` for the new nested field so an existing settings
file loads the V1 default without resetting unrelated preferences. An unknown
`extensionUi.version` resets only the nested Extension UI settings. A malformed
individual Extension/family entry is dropped by the nested sanitizer; it must
not send the entire DesktopSettings file through corrupt-file recovery.

The app store is the only writer. Each Settings action, completed drop/resize,
or Undo performs a functional update against the latest in-memory value, sends
one complete validated `extensionUi` snapshot in the existing top-level
`desktop_settings_patch`, and commits the returned native snapshot. Nested
partial patches are forbidden because the native patch contract replaces a
top-level field. Equal snapshots are a no-op, writes are serialized, and a
replayed observed-capability event cannot enqueue another write. This makes
nested updates atomic and idempotent without maintaining a second copy of Dock
order or dialog overrides.

Desktop derives only
`extensionDialogPresentationOverrides: Record<ExtensionId,
"followHost" | "inline" | "modal">` from the canonical profiles and sends that
bounded projection, together with `extensionDecisionPresentation`, through
`extensionUi.configure`. Host never receives Float rects, Dock layout,
capabilities, hidden states, or the full DesktopSettings object. The Host
configure contract and routing precedence are normative in
[Extension presentation](./extension-presentation.md).

Load validates:

- stable, syntactically valid Extension identities;
- known family names;
- legal home values per family;
- finite, viewport-clampable Float rects;
- for a detached Float, a finite screen rect and a well-formed monitor
  descriptor, resolved against the live monitor set as described in
  [Detached placement and monitor recovery](#detached-placement-and-monitor-recovery);
- Dock group, direction, order, and size ratio;
- the live Float cap across both containers;
- bounded Extension/capability counts and serialized size.

Unknown versions reset presentation preferences to defaults. Invalid individual
profiles are dropped and re-resolved without preventing the rest of Settings
from loading. Observed capabilities may be retained when independently valid.

A detached Float keeps its attached rect alongside its detached placement, so
re-attaching and monitor-recovery fallback both have a defined destination
without inventing geometry. Detached placement is an **optional key on the
existing `float` home, not a schema-version bump**: a V1 file loads with every
Float attached, which is exactly V1 behavior, and a V2 file read by an older
PiDeck loses only the one affected family instead of resetting every Extension
UI preference the way an unknown `version` would.

Writes occur atomically after Settings changes, completed drops, completed
resizes, completed tear-off/re-attach gestures, and Undo. Pointer movement never
writes DesktopSettings continuously, and neither does moving a detached window.

For any batch that changes `desktop_settings.rs`, `verify:quick` is necessary
but insufficient: run `pnpm lint:rust` and the focused Desktop settings Cargo
tests (or `pnpm test:rust` when no narrower command is maintained) in addition
to the relevant TypeScript and DOM tests.

Uninstalling an Extension does not immediately erase its profile; reinstalling
the same trusted identity recovers the user's choice. Settings offers an
explicit “Forget UI settings” action. A bounded least-recently-seen cleanup may
remove long-absent uninstalled identities, never active or installed ones.

## Native Browser surface

Browser remains the existing fixed RightDock Web tab and never participates in
Extension Deck layout.

This removes the broad Deck's hardest native requirements: no Browser drag,
Browser split, native float, or per-layout rect restoration.

Two native rules remain:

1. An **attached** Extension Float cannot overlap the visible native Browser
   rect. Drag snaps outside it with a visual exclusion hint. Docked Extension
   content and Web are mutually exclusive RightDock tabs, so they do not
   overlap. A **detached** Float is in a different OS window and cannot be
   occluded by a child webview, so the exclusion rule does not apply to it —
   detaching is a legitimate way out of the exclusion, and re-attaching
   re-imposes it.
2. A reference-counted native occlusion guard hides Browser surfaces while the
   Host modal layer, Settings, or another HTML dialog must cover them. Only the
   final release restores the currently active Web tab. Detached Float windows
   never take the guard: they cannot be covered by the Browser and must not
   blank it.

## Focus, keyboard, and accessibility

The existing focus and keymap semantics remain authoritative:

- `.xterm` gating and `worksInTerminal` stay unchanged;
- `chat.stop` Escape continues to use the Chat composer selector;
- Host modal presentation blocks background interaction;
- `mod+b` and `mod+j` keep toggling Sidebar and RightDock;
- builtin Dock activation commands keep their current meaning.

New commands are scoped to Extension surfaces:

- focus next/previous Extension Float;
- move a focused widget or `custom()` slot to a legal Dock / Float / anchor;
- detach the focused Float to a window and re-attach it;
- activate next/previous tab in the focused Extension Dock group;
- move the focused slot between primary and secondary Dock groups;
- resize the Extension Dock split;
- reset the focused Extension family to its default presentation.

Pointer actions, Settings controls, and keyboard commands call one pure
presentation-update layer, so all paths enforce family policy and write the
same global profile.

Anchors and Dock groups use the repo's existing `tablist` / `tabpanel`
patterns. The single Dock separator uses `role="separator"` with ARIA values.
Floats are labelled non-modal dialogs. Focus returns to the invoking or nearest
stable shell control when session content disappears.

Detaching adds a focus boundary the HTML float layer never had:

- an attached Float restores focus to its invoking control, as today; a
  detached Float's window cannot reach that element, so destroying it returns
  focus to the main window's nearest stable shell control instead;
- detaching moves keyboard focus with the content, so the gesture does not
  strand the user's focus in an empty float layer;
- “focus next/previous Extension Float” traverses attached and detached shells
  in one order and raises the target window when it is detached;
- a detached Float is still a labelled non-modal dialog and never traps focus.
  It has its own window chrome, so it also honors the platform's own window
  close and cycle shortcuts;
- global chat commands such as `chat.stop` belong to the main window and are
  not rebound inside a Float window.

Structured widget controls are ordinary focusable host controls inside their
slot: real buttons with accessible names, tab order, and `confirm` prompts
rendered by PiDeck. A widget action never moves focus on its own.

## Cut line — what remains unchanged

Everything below presentation stays intact:

- Extension request ownership;
- epoch and active-session alignment;
- decision groups and expiry;
- respond lifecycle;
- VirtualTerminal input/resize identity checks;
- Host-owned risk/ownership guards and existing
  `extensionDecisionPresentation` modes; the policy gains only the bounded
  per-Extension blocking-dialog override tier defined in
  [Extension presentation](./extension-presentation.md);
- provider/package/session runtimes;
- transcript-owned presentation rows and renderer snapshots.

The transcript is conversation history, not a presentation slot. Global UI
preferences never rewrite transcript content.

## What stays, changes, and is removed

| Existing area                            | Fate                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| `Sidebar`                                | **kept** unchanged as fixed sessions shell                                     |
| `RightDock`                              | **kept**; gains one dynamic `Extensions` tab and bounded internal group layout |
| Files / Tree / Git / Shell / Web tabs    | **kept** fixed; no move/split/float affordances                                |
| Dock width/open preferences              | **kept**; no import or migration                                               |
| Chat shell                               | **kept**; gains named Extension anchors                                        |
| Settings page                            | **kept**; gains per-Extension UI presentation sections                         |
| `ExtensionWidgetsPopover`                | **removed**, replaced by anchors / Float / Extensions Dock                     |
| current custom terminal fixed-Dock mount | **replaced** by the presentation resolver                                      |
| bespoke inline/modal decision mounts     | content shell unified where practical; Host modal boundary remains             |
| Extension UI stores                      | **kept** as session content sources; global profiles live separately           |
| whole-window `DeckLayout`                | **not built**                                                                  |

Unlike the original Deck, this design does **not** delete `RightDock`,
`DockTabId`, Sidebar, or builtin surface wiring.

## Build order

The target lands in four independently green batches. Each passes
`verify:quick`; Rust settings changes also pass `lint:rust` and focused Cargo
tests. Unfinished presentation remains behind `extension-deck-v1` until its
family cuts over.

1. **Contracts, identity, capabilities, and settings.** Add optional trusted
   origin to widget/status/custom-start events, the custom overlay hint, exact
   validators, DTO/protocol coverage, emit-site/replay tests, stable
   `ExtensionId`, Desktop-owned idempotent observation, the complete
   TypeScript/Rust `ExtensionUiSettings` persistence path, Settings UI, the
   filtered `extensionUi.configure` dialog override map, Host routing priority,
   and pure policy tests. No visual surface moves yet.
2. **Composer anchors and Float layer.** Cut widget then status over to
   presentation slots. Add global move/resize persistence, Undo toast, Float
   cap, session-switch tests, and remove the widget popover.
3. **RightDock Extensions area.** Under `extension-deck-v1`, add the single
   dynamic tab, primary/secondary bounded groups, tab/drop/keyboard behavior,
   and global ratio/order settings. Cut `custom()` from per-request top-level
   tabs to family slots while keeping request-keyed transport; exercise legacy,
   new, and rollback paths and preserve all builtin Dock behavior and tests.
4. **Blocking-dialog preference and native guard.** Apply the per-Extension
   Follow Host / Inline / Modal preference already resolved by Host to low-risk
   cards, keep mandatory modal policy locked, unify card content mounts, add
   Browser exclusion/occlusion handling, remove legacy Extension surface
   special cases after the compatibility release, and run cross-session
   acceptance tests.

No builtin migration batch exists.

### V2 batches

V2 continues the same rule: each batch is independently green and independently
shippable, and an unfinished surface stays behind its gate. Detached floats land
before structured widgets, because the float container is the harder and riskier
of the two and the widget schema does not depend on it.

Two spikes gate batch 6, not batch 5. Both are throwaway measurements, not
products, and both decide how good the gesture can feel rather than whether the
feature is possible:

- **S1 — cross-screen pointer coordinates.** With pointer capture held, confirm
  that movement past the main window's bounds keeps reporting usable screen
  coordinates across monitors with different scale factors, on every supported
  platform. If it does not, tear-off falls back to committing on release at the
  last known position.

  _Measured 2026-08-23, macOS 15 / WKWebView, single 1512×982 display at
  `devicePixelRatio` 2, 2913 samples over 6 drags._ Pointer capture keeps
  delivering `pointermove` past the window's bounds (1650 out-of-window
  samples), and `screen − client` is **exactly** invariant: 0.0 px drift on
  both axes, no outliers, across two different window positions. On this
  configuration either positioning formula works and live tear-off is viable.
  The cross-monitor and mixed-scale-factor half of S1 remains unmeasured on
  every platform, and Windows per-monitor DPI is the case most likely to break
  the invariant. Rerun before committing to batch 6.

- **S2 — pointer-driven window movement.** Measure whether moving a window once
  per animation frame from the main window's pointer stream is smooth enough to
  read as dragging. If it is not, batch 6's live tear-off is replaced by a
  ghost outline that commits on release.

5. **Detached float placement and window shell.** Add the screen-space
   placement model, the additive optional placement key, monitor matching and
   reattach fallback, and the pure geometry/hit-test modules with their unit
   tests. Add
   the float window entry point, its capability entry, the thin-client content
   and intent channel, and orphan cleanup on boot and shutdown. Detach and
   re-attach are available from the slot context menu and the keyboard command
   only. No drag gesture yet, so the batch is shippable without S1 or S2.
6. **Tear-off and re-attach gestures.** Add the pointer-driven detach threshold,
   live window tracking, drop-zone hit-testing from a detached window, Escape
   cancellation, and the degraded paths S1/S2 select. Cover cap enforcement,
   monitor loss during a drag, and main-window shutdown mid-gesture.
7. **Structured widgets.** Add the payload schema, validators, and DTO/protocol
   coverage; the `structured` renderer and its fallback to the read-only text
   renderers; the `extensionUi.widgetAction` method with ownership, epoch, and
   bound guards; and the bridge-side handler registry with its SDK-patch type
   declaration. Renderer and transport land together so no half-interactive
   widget is ever published.

## Acceptance criteria

1. With no active Extension UI, the window matches today's PiDeck
   pixel-for-pixel and the Extensions tab is absent.
2. Files, Tree, Git, Shell, Web, Sidebar, and Chat expose no drag, Float, or
   split affordances and retain existing commands/preferences.
3. First-use widget/status/`custom()` defaults reproduce SDK hints; widget anchors
   intentionally replace the popover drawer.
4. Settings lists only observed surface families and only legal presentation
   options for each one.
5. A Settings change rehomes current non-blocking content immediately and
   applies to every session/workspace. A blocking-dialog change applies to the
   next Host-routed request; an already-published request does not move locally.
6. A completed widget/`custom()` drag or Float resize updates global Settings,
   displays “applies to all sessions,” and supports Undo.
7. Switching sessions loads no presentation layout and never changes the saved
   location of an Extension family.
8. Missing content leaves no empty Float, Dock tab, or anchor block; blocking
   dialogs and `custom()` are never hidden or unreachable while awaiting input.
9. Extensions Dock never has more than two groups and never contains a builtin
   surface.
10. High-risk/lifecycle decisions remain non-movable Host modals regardless of
    settings or drag history.
11. Native Browser never covers Host modal/Settings/dialog UI and never appears
    as a movable Extension surface.
12. Corrupt profiles recover per Extension/family without breaking unrelated
    DesktopSettings.
13. Replayed widget/status events and repeated family events do not produce
    additional DesktopSettings writes.
14. Host-final high-risk, lifecycle, and inline-unavailable requests remain
    Modal even when their global Extension profile says Inline; trusted normal
    requests receive the documented `user-extension-*` route reason.
15. With `extension-deck-v1` off, legacy per-request custom tabs work and ignore
    but preserve global profiles. With it on, a custom request creates only the
    single Extensions top-level tab path; rollback changes no builtin Dock
    preference.
16. Blocking dialogs expose only Follow Host / Inline / Modal; none can enter
    Dock, Float, Anchor, or hidden state.
17. Status exposes only above-composer / Dock / hidden and never becomes a
    standalone Float.
18. `setTitle`, loader APIs, editor/TUI chrome, transcript renderers, commands,
    and shortcuts receive no presentation homes.

### V2 acceptance criteria

19. With no float detached and no structured payload published, behavior is
    identical to V1, and a V1 settings file loads with every float attached.
20. Detaching preserves slot identity: the same Extension family keeps its
    content, its Settings row, and its place in the float cap. Eight is still
    the total across both containers, and detaching never creates a ninth.
21. A detached float survives the main window changing pages, and disappears
    when its session content ends, when the main window closes, and when the
    Host restarts. No orphan window outlives the application, including after a
    crash and relaunch.
22. A detached window renders one slot and nothing else: it issues no Host
    request, holds no session or workspace state, and writes no settings.
23. A placement whose monitor is absent reattaches the float to the main window.
    No window is ever created off-screen or silently moved to another monitor.
24. Tear-off and re-attach commit exactly one settings write on release, show
    the “applies to all sessions” toast, and support Undo. Moving a detached
    window writes once on release, never continuously.
25. Escape during either gesture restores the pre-drag container and placement.
26. A still-live `custom()` request is never left without a reachable surface by
    detaching, re-attaching, monitor loss, or window destruction.
27. A structured payload renders as host-owned controls in every home; any
    non-matching or newer-versioned payload renders through the existing
    read-only text renderers rather than erroring.
28. `string[]` and factory-rendered widgets expose no actions. PiDeck never
    derives a control from widget text.
29. A widget action reaches only the trusted origin that published that key.
    Actions against a stale key, an unknown action id, a missing handler, or a
    superseded epoch are rejected, and none of them produce a transcript entry
    or an agent turn.
30. Status and blocking dialogs expose no detach affordance, and no builtin
    surface, Chat, Sidebar, RightDock, or Settings page can leave the main
    window by any path.

## Decisions recorded here

| Decision                                                  | Rationale                                                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Keep Sidebar, Chat, and RightDock fixed                   | They already have useful product-owned homes; moving them adds cost without solving Extension presentation                |
| Keep builtin RightDock tabs immovable and unsplittable    | Files/Tree/Git/Shell/Web movement is not a user requirement                                                               |
| Add a dynamic `Extensions` tab                            | Gives Extension surfaces a dockable home without mixing them into builtin tab semantics                                   |
| Limit Extensions Dock to two groups                       | Covers practical comparison/workbench use without a recursive pane engine                                                 |
| Store profiles globally per Extension + family            | Every session behaves consistently and session switching does not reconcile layout                                        |
| Dragging changes global Settings                          | There is one explainable source of truth; no hidden session override layer                                                |
| Aggregate live widget keys into a family slot             | Avoids unbounded per-key geometry and stale layout memory                                                                 |
| Learn supported families by observation                   | Existing Extensions need no manifest or code change                                                                       |
| Host mandatory guards precede user preference             | Presentation freedom cannot weaken ownership, risk, lifecycle, or surface-availability routing                            |
| Blocking dialogs only choose Follow Host / Inline / Modal | Waiting requests stay visible and reachable; Dock/Float freedom is not worth the blocking-state ambiguity                 |
| Status cannot Float                                       | Passive one-line chrome belongs in its composer strip or the shared Extensions Dock, not a proliferation of micro-windows |
| Widget has the broadest placement set but stays read-only | Superseded by the V2 table below; moving content still does not invent input semantics, only a declared payload does      |
| `custom()` only chooses Follow Extension / Dock / Float   | It is focused interactive content that must remain visible until `done()`                                                 |
| SDK hints remain selectable defaults                      | “Follow Extension” preserves `placement` / `overlay`; an explicit global user preference remains stable                   |
| Float geometry is global and normalized                   | Placement survives sessions, projects, and window-size changes                                                            |
| Session content clears; presentation profile remains      | Preserves SDK lifecycle while avoiding layout churn                                                                       |
| Notifications stay out                                    | Transient signals have no durable spatial identity                                                                        |

### V2 decisions

| Decision                                                         | Rationale                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Detached is a container of the `float` home, not a new home      | Family policy, Settings rows, drag rules, and the float cap stay one code path; the presentation choice list does not grow                                                                                                                                    |
| Only widget and `custom()` may detach                            | Detaching selects a container for an existing float, so it inherits exactly the families that could already float                                                                                                                                             |
| A detached float is a thin client, not a second app instance     | Keeps one Host client, one settings writer, one observation path, and one `configure` projection — the invariants V1 paid for                                                                                                                                 |
| The main window stays the only settings writer                   | A second writer reintroduces the write races the V1 serialized-update contract eliminated                                                                                                                                                                     |
| Gestures never hand off to a native window drag                  | A native drag loop delivers no pointer movement, so the app could not hit-test drop targets or highlight drop zones                                                                                                                                           |
| Detached placement stores monitor identity, not just coordinates | Coordinates alone cannot distinguish a reconnected monitor from a missing one; identity makes recovery decidable                                                                                                                                              |
| An unmatched monitor reattaches instead of clamping              | Silently relocating a float to another screen loses the user's actual choice; reattaching is visible and recoverable                                                                                                                                          |
| The float cap counts both containers                             | Detaching moves a shell rather than creating one, so the resource bound the cap protects is unchanged                                                                                                                                                         |
| A detached `custom()` panel is fed by relay, not by subscription | The float has no Host client, so the main window forwards frames on its behalf and turns keystrokes back into Host requests. It retains a capped tail so a window that opens mid-stream is repainted rather than blank, and hands that tail back on re-attach |
| A float may reach the clipboard, and nothing else                | A detached `custom()` panel is a real terminal, and the clipboard is the user's own rather than a channel into PiDeck state. Host transport, settings, shell, browser, dialogs, and updater stay withheld                                                     |
| Re-attach is offered by the float window, not the main window    | A detached slot is not drawn in the main window, so it can never be the focused slot there; the control belongs where the window actually has focus                                                                                                           |
| Structured widgets reuse `widget: JsonValue`                     | The action-carrying payload needs no new event, no SDK release, and no change to publication, aggregation, or placement                                                                                                                                       |
| Only a declared payload carries actions                          | Preserves the real V1 constraint — PiDeck must not infer intent from text — while letting an Extension state its intent                                                                                                                                       |
| Unknown payload versions fall back to text, never error          | A widget published for a newer PiDeck still shows its content                                                                                                                                                                                                 |
| The action row vocabulary stays output-shaped                    | Free-form entry, selection, and multi-step forms already belong to blocking dialogs and `custom()`                                                                                                                                                            |
| Widget actions are bridge-registered, not SDK-registered         | PiDeck already constructs the whole `ExtensionUIContext` it hands Extensions, so this costs a bridge method and a patched type, not an SDK release                                                                                                            |
| An action implies no prompt, turn, or transcript entry           | Clicking a control is a UI event; an Extension that wants agent effects performs them itself                                                                                                                                                                  |

## Non-goals

Two V1 non-goals were narrowed by the [V2 amendment](#v2-amendment--detached-floats-and-structured-widgets)
and appear below in their narrowed form. Everything else stands unchanged.

- A whole-window Obsidian/IDE pane workspace.
- Moving, floating, splitting, or duplicating builtin panels.
- Per-session layout or per-workspace layout.
- Per-widget-key presentation overrides.
- More than one nested Dock split.
- Dock, Float, Anchor, or hidden presentation for blocking dialogs.
- Standalone Status floats or below-composer Status.
- Presentation settings for notifications, `setTitle`, loader/editor/TUI
  chrome, transcript renderers, commands, or shortcuts.
- Multiple live Chat sessions in one window.
- **Narrowed in V2** — OS-level windows for anything other than a detached
  Extension float. Chat, Sidebar, RightDock, anchors, Settings, and the Host
  modal layer never leave the main window, and a float window never carries an
  application shell, a Host client, or a settings writer.
- Extension-shipped HTML, CSS, React, or renderer code.
- **Narrowed in V2** — inventing interactivity for text widget content. Plain
  `string[]` and factory-rendered widgets stay read-only; only an explicit,
  versioned, declared structured payload carries actions, and PiDeck never
  derives a control from a line of text.
- Free-form text entry, selection, or multi-step forms in the structured widget
  schema; those remain the job of blocking dialogs and `custom()`.
- Per-monitor presentation profiles, or any placement memory beyond one stored
  placement per detached float.
- Routing a widget action into a prompt, an agent turn, or a transcript entry.
- Notification/toast redesign beyond the global-change Undo message.
- Static source detection of “TUI-looking” packages or supported verbs.

## Implementation pointers

| Layer                              | Path                                                                                                        | Fate                                                                                                     |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Widget drawer                      | `apps/desktop/src/features/chat/ExtensionWidgets.tsx`                                                       | replaced by anchor / Float / Dock presentation slot                                                      |
| Decision modal                     | `apps/desktop/src/features/chat/ExtensionUiModal.tsx`                                                       | retains Host modal boundary; card content can share renderer                                             |
| Inline decision                    | `apps/desktop/src/features/chat/InlineExtensionUiRequest.tsx`                                               | used when the resolved low-risk preference is inline                                                     |
| Right rail                         | `apps/desktop/src/components/RightDock.tsx`                                                                 | kept; gains dynamic Extensions tab and bounded groups                                                    |
| Left rail                          | `apps/desktop/src/components/Sidebar.tsx`                                                                   | unchanged                                                                                                |
| Extension UI state                 | `apps/desktop/src/lib/stores/extension-ui-state.ts`, `app-store.ts`                                         | kept as session-bound content source                                                                     |
| Global settings                    | DesktopSettings store and Settings UI                                                                       | add profiles, capabilities, Dock settings, validation, and Undo                                          |
| Protocol event/configure contracts | `packages/protocol/src/types.ts`, `contracts.ts`, `validate.ts`, `dto-validate.ts`, protocol coverage tests | add three optional event origins, custom overlay, dialog override map, and route reasons                 |
| Host bridge                        | `packages/pi-host/src/extension-ui-bridge.ts`                                                               | attach trusted widget/status/custom origin, custom overlay hint, and consume configured dialog overrides |
| Routing policy                     | `packages/pi-host/src/extension-ui-policy.ts`                                                               | retain mandatory guards; add the per-Extension preference tier and pure precedence tests                 |
| Desktop settings client/store      | `apps/desktop/src/lib/desktop-settings.ts`, `apps/desktop/src/lib/stores/app-store.ts`                      | strict validation, hydration, idempotent observation, serialized whole-field patches                     |
| Native settings store              | `apps/desktop/src-tauri/src/desktop_settings.rs`                                                            | mirror defaults/validation/repair/patch/persistence and focused Rust tests                               |
| Native webviews                    | `apps/desktop/src-tauri/src/browser_surface.rs`                                                             | keep fixed surface; add exclusion rect and reference-counted occlusion guard                             |

### V2 pointers

| Layer                       | Path                                                                                        | Fate                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Float shell and float layer | `apps/desktop/src/features/extensions/ExtensionPresentationMounts.tsx`                      | gains the container split; the shell body is shared by the attached layer and the float window root               |
| Float geometry              | `apps/desktop/src/lib/extension-ui-float-geometry.ts`                                       | keeps the viewport model for attached floats; gains the screen-space model, monitor matching, and bounds hit-test |
| Drag state and drop targets | `apps/desktop/src/lib/extension-ui-drag-state.ts`, `extension-ui-drop-target.ts`            | extend to cross-window drags so tear-off and re-attach reuse one legality and highlight path                      |
| Float window entry point    | `apps/desktop/src/main.tsx` and a new float root under `features/extensions`                | branch on the `surface=float` entry point; mount one slot with no application shell                               |
| Float window channel        | new module under `apps/desktop/src/lib/`                                                    | forward content and chrome out, intent back; the only bridge between the main window and a float window           |
| Native window management    | `apps/desktop/src-tauri/src/` (new module), `capabilities/default.json`                     | create/destroy/move float windows, enumerate monitors, orphan cleanup; add the float webview capability entry     |
| Renderer form               | `apps/desktop/src/lib/extension-ui-renderer-form.ts`                                        | add the `structured` form selected by payload rather than by home                                                 |
| Structured widget renderer  | `apps/desktop/src/features/extensions/ExtensionWidgetContent.tsx`                           | add host-owned controls; keep every existing text renderer as the fallback path                                   |
| Widget action contract      | `packages/protocol/src/methods.ts`, `contracts.ts`, `validate.ts`, `dto-validate.ts`, tests | add `extensionUi.widgetAction` with the same session-target context and bounds as `customInput`                   |
| Widget action bridge        | `packages/pi-host/src/extension-ui-bridge.ts`, `patches/`                                   | add the per-key handler registry and its `ExtensionUIContext` type declaration                                    |
