# Native system-notification planning findings (2026-09-01)

- Current behavior is entirely in-window: `NotificationCenter` renders a bell,
  retained list, unread badge, and six-second React toast stack.
- PiDeck has neither the Rust nor JavaScript Tauri notification dependency,
  does not initialize the plugin, and grants no notification capability.
- The design must start from attention-worthy domain events rather than mirror
  all app notifications; the existing store includes routine success/info
  messages that would become noisy as OS alerts.
- Official Tauri v2 notification support covers macOS and Windows. Permission
  must be checked/requested before sending; Windows notification identity is
  only trustworthy in an installed build and may appear as PowerShell in dev.
- `agent.event` already carries `runId`, concrete workspace/session identity,
  and normalized lifecycle types including `agent_end`, `agent_settled`,
  `error`, compaction, and retry events. This is a stronger trigger source than
  observing Zustand `isIdle` transitions, which can also represent compaction,
  recovery, aborts, or snapshot replacement.
- The Host emits `agent_end` before final lifecycle snapshot publication and
  may later emit `agent_settled`; background runtimes are retained and also
  publish identity-scoped agent events. Completion deduplication therefore
  needs a key such as `hostInstanceId + workspaceId + sessionId + runId`, and a
  defined terminal event (`agent_end` unless it advertises a retry, otherwise
  the eventual terminal event).
- The current Desktop error branch already derives a safe failure message from
  `agent.event.type === error` and inserts an in-app notification. Native errors
  should hook the same semantic event while retaining the in-app record.
- Desktop identity policy intentionally accepts `agent.event`,
  `session.runtimeChanged`, and `extensionUi.request` from non-active sessions
  as long as the Host generation matches. Native notification routing can
  therefore cover background sessions without weakening validation.
- `extensionUi.request` is the existing typed “needs user input” signal. It has
  request/session identity, kind, safe title/message fields, timeout, risk,
  origin, and already classifies delivery as active/background/candidate. It is
  the correct second notification seam; generic widget-attention or arbitrary
  Extension notification events should not automatically become OS alerts.
- No app-wide foreground-state service exists. Draft persistence uses DOM
  `visibilitychange`; transcript following uses window focus/blur; neither is a
  durable notification policy. Add one main-window attention-state controller
  combining Tauri window focus/visibility with `document.visibilityState`, and
  treat “unknown” conservatively as foreground during startup/tests.
- `session.runtimeChanged` provides catalog state for background sessions but
  has no `runId`. Use it for navigation/status refresh only, not completion
  deduplication.
- The SDK's `AgentSessionEvent` contract confirms `agent_end` includes
  `messages` and `willRetry`, while `agent_settled` is payload-free and emitted
  in the run-finally path. The notification classifier should inspect the
  terminal assistant `stopReason` for `aborted`/`error` and use `willRetry` to
  defer until the final retry.
- Tauri's notification API exposes `isPermissionGranted`, `requestPermission`,
  `sendNotification`, and `onAction`; options support `extra`, `autoCancel`,
  `group`, and `tag`. The plan only needs the first three plus `onAction` and
  opaque `extra` routing metadata. Native support is documented for both
  macOS and Windows, with Windows installed-build identity caveats.
- Detached Floats currently have a thin-client channel but no focus relay. A
  focused Float must emit a small focus-state intent (or Rust window manager
  event) to the main window so native-alert suppression reflects the whole
  PiDeck window set.
- Implemented the Float focus relay as a typed `focus` intent over the existing
  thin-client channel; the main controller publishes a browser event consumed
  by the app-level notification attention state.
- Desktop settings use versioned Rust serde defaults plus a TypeScript patch
  allowlist. Adding one boolean is a backward-compatible migration, but it
  requires updates to both validators, defaults, settings UI, and settings
  fixtures.
- The existing i18n layer has explicit `en`, `zh`, and `system` resolution, so
  native notification copy should be generated at the Desktop boundary using
  the same resolver. The plugin receives already-localized strings; it should
  never own translation or fall back silently to English.
- Bilingual coverage must include OS-facing strings as well as React UI:
  notification title/body, General Settings label/description, permission
  denial/unavailable fallback, stale-session click result, and Host recovery
  destination. Tests should switch the store language and assert both exact
  localized payloads.
- The implementation keeps OS bodies generic and localized at send time, while
  the notification `extra` carries only validated routing metadata. English and
  Chinese classifier copy plus Chinese General Settings coverage are now tested.

# Direct thinking-control findings (2026-09-01)

- The live session can report `max`; map it to the polished English label `Max`
  instead of exposing the raw lowercase provider value.
- Implementation inspection confirms the control sits immediately before
  `ContextUsageRing`, reuses the guarded session request path, and preserves the
  existing nested per-model thinking menu.
- Final desktop UI rules favor exactly this shape: direct click access rather
  than hover-only discovery, an explicit accessible name, keyboard navigation,
  visible focus, disabled semantics while loading, no color-only state, and
  transform-only motion with a reduced-motion override.
- User requested a quieter visual hierarchy after the first implementation;
  use 11px for both the persistent value and menu rows, with an 11px chevron.
- Computer-use resolution for live QA: no managed CLI override is present on
  this macOS session, so the version-matched executable is `/usr/local/bin/orca`.
- Live 1280×800 visual inspection confirms `Max` appears immediately left of
  the 5% context ring, aligns with the model row, remains readable at 11px, and
  has enough separation from both the ring and send button without widening the
  Composer chrome noticeably.
- The live menu opens upward from the label at a compact 112px minimum width,
  fits four 28px rows without empty padding, stays clear of the context ring,
  and exposes `Off / Low / High / Max` with a visible check plus semantic
  selected state; focus lands on the active `Max` row as designed.
- Live mutation verification succeeded: selecting `High` immediately updated
  the direct label and closed the menu, then selecting `Max` restored the user's
  original setting; focus returned to the trigger after each request.

- Composer currently places attachments + model on the left, then context ring
  + send on the right. The requested control belongs immediately before the
  context ring so it reads as a per-send parameter without crowding the model
  label.
- The existing model menu already owns the authoritative level list, guarded
  `model.setThinkingLevel` request, current-session update, and error toast.
  The direct control should reuse those semantics for the active model rather
  than introduce cycling or optimistic state.
- Visible copy should remain canonical English (`Off`, `Low`, `Medium`, etc.)
  under every locale; only the full accessible name should be localized.
- The store's `thinkingLevels` is refreshed with `model.list` and after model
  switches, so a separate current-model control can consume it without another
  Host request. Hide the control unless there are at least two distinct levels.
- Factor the guarded `model.setThinkingLevel` request into one helper shared by
  the existing per-model submenu and the new direct control. This avoids two
  subtly different generation/race/error paths.
- The direct menu should open upward and right-aligned, focus the current level,
  support Escape/outside dismissal, disable during the request, and keep the
  visible labels English even under Chinese locale.

# Detached widget collapse parity findings (2026-09-01)

- The detached root does render the shared disclosure button. The failure is
  state ownership: `ExtensionWidgetRows` calls the detached window's isolated
  Zustand action, while `toggleExtensionWidgetCollapsed` intentionally refuses
  keys absent from that store's `extensionWidgets` map. Forwarded Float widget
  content never populates that map, so every click is a no-op.
- The shared disclosure is already a semantic button with `aria-expanded`,
  `aria-controls`, localized labels, a visible focus ring, and reduced-motion
  handling. No new visual pattern is needed; the fix belongs at the detached
  window state/intent boundary.
- Correct parity requires main-window ownership: add a narrowly validated
  `toggleWidgetCollapsed` Float intent, include only this Float's collapsed
  widget keys in its content message, and let `ExtensionWidgetRows` accept that
  state as a controlled override. This preserves collapse when the widget is
  reattached and prevents a detached window from mutating arbitrary keys.
- `ExtensionFloatWindowController` must subscribe to the collapsed-key map so a
  successful toggle causes a new content message; `floatContentChanged` will
  then naturally publish the state delta without a special acknowledgement.
- Live verification confirmed the full round trip: detached `rpiv-todos`
  changed from expanded with two text rows to a collapsed disclosure-only tree,
  expanded again, then reattached above Composer with content still expanded.

# Findings: Pi SDK 0.84.2 upgrade audit

## Requirements
- User asked how to upgrade from pinned `0.82.1` to upstream `0.84.2`.
- Do not install 0.84.2 into the workspace until the bump is intentional and atomic.
- Preserve the 0.82.1 playbook: no mixed SDK versions on `main`, no hitchhiking toolchain upgrades.

## Research Findings

### Tarball hashes (npm pack, 2026-08-20)
Recorded in `%TEMP%\pideck-sdk-0842`. Re-hash before the real bump; npm tarballs can be republished.

```
0262785a76b0eb2eec596cd8a7ab2ee23eef89d2ef1bb1211c4f0a1944dacf41  earendil-works-pi-ai-0.84.2.tgz
95b899cd7b1a0c1f0174c7bf33ab427435e3553a7d1f4756661aa9c7f1a68ffa  earendil-works-pi-coding-agent-0.84.2.tgz
3abec26d852a9574fd341b8b4984277fc76dabb57a0360df4c19cc1fc0df993e  earendil-works-pi-tui-0.84.2.tgz
565b5d2c6f6c09ff69d915d28692a15d72dedc43a7dbe41fb422bb4bfad3bdcf  earendil-works-pi-agent-core-0.84.2.tgz
```

coding-agent `engines.node` is still `>=22.19.0`. Direct deps add `@earendil-works/pi-client` and `@earendil-works/pi-protocol` (not `@pideck/protocol`) at `^0.84.2`. TypeBox moves from `@sinclair/typebox` to the `typebox` 1.3.7 package.

### Breaking changes that actually hit PiDeck

| Change | Hits PiDeck? | Notes |
|--------|--------------|-------|
| JSON/RPC `message_update` drops cumulative `message` and `partial` | Low | Host listens to in-process `AgentSession`, not JSON mode. `pi-ai` `AssistantMessageEvent` still has `partial`. Host `event-normalize.ts` already keeps only `assistantMessageEvent` and still reads `partial` for `toolcall_start`. JSON helper `toJsonEvent` is unused. |
| `ProviderHeaders` = `Record<string, string \| null>` | Yes | SDK surfaces keep null sentinels. Host-built HTTP headers drop nulls via `stringRecord()`. `providerHeadersToRecord` is not a public pi-ai export. |
| `ModelRegistry.refresh()` now takes `ModelsRefreshOptions` and returns `ModelsRefreshResult` | Comment-only | Host already calls `ModelRuntime.refresh({ allowNetwork: false })`. Keep that helper; do not switch back to the registry. `ModelsRefreshOptions` also gained `providers?: readonly string[]`. |
| `setRuntimeApiKey` auth options | No | PiDeck does not call it. |
| TypeBox 1.3.7 / package `typebox` | Yes | `attachment-tool.ts` is the only Host import of `@sinclair/typebox`. `defineTool` parameters are `TSchema` from `typebox`. |
| Config-form OAuth `refreshToken(credentials, signal)` | Required search | Host has no first-party callback today. Still search Host, fixtures, and test extensions; add a runtime compat test. Compile-green is not enough. |
| Handwritten `Provider.refreshModels` `context.store` → `context.stored`/`publish` | Unlikely | Host uses `createProvider` / ModelRuntime, not a handwritten native `refreshModels`. |
| pi-agent-core v4 Session/SessionRepo | Unlikely | Host uses coding-agent `SessionManager`, not pi-agent-core repos. Confirm no deep imports. |
| `StopReason` adds `pending` and `deferred` | Small | `done.reason` is already any string in the normalizer. `done` union now includes `deferred`. Protocol does not enum-check assistant stop reasons. |

### Surfaces that did not change enough to drop the dist patch

Confirmed absent from 0.84.2 `d.ts`/`js`:

- `AgentSession.clearModel()`
- `ExtensionBindings.invocationRunner` / `ExtensionRunner.setInvocationRunner`
- `PackageManager.setOperationSignal`
- `update(source, { local })`
- `PackageManagerOptions.env` / `DefaultResourceLoaderOptions.env`
- `getShellConfig` bundled-bash fallback
- `killProcessTree` still `spawn("taskkill")` with no `error` listener

`wrapper.js` was rewritten (tool wrapping only, direct `execute()`). Re-port invocation wrapping onto the new wrapper; do not apply the 0.82.1 hunk. Also patch `AgentSession.bindExtensions` / `_applyExtensionBindings` so `invocationRunner` survives reload.

`package-manager.js` `spawnCommand` still uses `getEnv()` → `process.env` in the unpatched SDK. Cut 1 Host adapter now replaces spawn/capture/sync/update on the prototype and injects `getInternalRuntime().env`.

`CreateAgentSessionOptions.model` is `Model | undefined` again; empty values call `findInitialModel()`. The 0.82.1 sdk.js `model: null` hunk is product-critical.

### Review 2026-08-20 (Accept with changes)
Static review of the repo, current patch, and official 0.84.2 tarball. Six packages' `dist-tags.latest` were 0.84.2; Git tag and npm `gitHead` pointed at `914cf147`. No files were modified and no workspace tests were run in that review.

Blockers folded into `docs/operations/pi-sdk-0.84.2-upgrade.md`:

1. **T8 / `model: null`.** Plan had described `sdk.{js,d.ts}` as type re-exports. The patch actually disables auto-selection; Host depends on it (`agent-session-factory.ts`). Use a Host `PIDECK_NO_MODEL` sentinel for create + clear; keep empty-enabled-list tests.
2. **P8 scope.** Cannot be `runner.js` only. Need agent-session bind/reload, runner events, and a rewritten wrapper for Extension tools (`sdk-invocation-runner.test.ts`).
3. **P1–P3.** Three spawn wrappers miss signal consumption, scoped `update`, `waitForChildProcess`, and stderr. Timebox a full spike or keep a minimal `package-manager.js` patch.

Also: keep P4+P5 in `shell.js`; one PR; six-package evidence list; product 0.2.2; Cut 2 freshness gate; OAuth `refreshToken` is a required search including fixtures.

### New optional APIs we can ignore in the first bump
- `PromptOptions.expandPromptTemplates` (default true)
- `CreateModelRuntimeOptions.signal` / `refreshOnCreate`
- `defaultTools` setting (product follow-up, not required to compile)
- Baseten / Qwen Individual providers (catalog, not Host code)
- `@earendil-works/pi-coding-agent/client` remote session APIs

### Current patch file list (0.84.2)
Residual is **by behavior**: invocation ownership (session+runner+wrapper+types) and `shell.js`. PM/resource-loader stayed out after the Cut 1 spike. `sdk.js` stayed out; T8 sentinel was not falsified.

Current 0.84.2 files (`patches/@earendil-works__pi-coding-agent@0.84.2.patch`):

1. `dist/core/agent-session.d.ts` + `.js` — invocation bind / reload (P8)
2. `dist/core/extensions/{index,runner,types}.d.ts` + `runner.js` — invocation events (P8)
3. `dist/core/extensions/wrapper.js` — rewritten tool `invokeExtension` on the 0.84.2 execute wrapper
4. `dist/index.d.ts` — export invocation types (P8)
5. `dist/utils/shell.js` — bundled bash + absolute `taskkill` (P4+P5)

`package-manager` and `resource-loader` hunks stayed out. Host `installPackageManagerAdapter()` replaces spawn/wait/signal/scoped `update` and reads `getInternalRuntime().env`.

`sdk.{js,d.ts}` is gone from the 0.82.1 patch. T8 sentinel was not falsified: `createHostAgentSession` with `PIDECK_NO_MODEL` constructs a real AgentSession (`unknown`/`unknown`) and does not persist that pair as `settings.json` defaults.

### Better method than the 0.82.1 playbook
Last upgrade was an API replacement (AuthStorage → CredentialStore, new ModelRuntime). This one is a patch-rebase tax plus two type breaks. Copying the 6-PR dist rebase would keep the expensive part.

Chosen method after review (see `docs/operations/pi-sdk-0.84.2-upgrade.md`):

1. Two cuts in **one PR**. Cut 1 on 0.82.1 is independently testable; do not merge it to `main` alone.
2. Move T8 (`model: null` → sentinel), P6 (`clearModel`), and P7 (pideck UI types) into Host.
3. P1–P3: timebox a complete PM-adapter spike; if it cannot reproduce wait/signal/scope, keep the minimal `package-manager.js` patch.
4. Keep P4+P5 in `shell.js`. Keep P8 as session bind + runner events + rewritten wrapper + type exports.
5. Atomic 0.84.2 bump with a freshness gate. Skip 0.83.0. Product version 0.2.2.

### Cut 1 traps found while writing the review packet
- Host tests have no vitest `setupFiles`; adapters installed only in `main.ts` will not run in unit tests.
- `runCommandSync` still calls `getEnv()` directly; wrapping only `spawnCommand` is insufficient (`sdk-package-internal-env.test.ts`).
- 0.84.2 `ResourceLoader` still `new DefaultPackageManager` without `env`. Prototype hooks must read `getInternalRuntime()`.
- Tests pass constructor `env` today; that option dies when the patch hunk is removed. Need `setInternalRuntimeForTests`.
- `SettingsManager.applyOverrides` is non-persisting and `getShellPath()` reads merged `this.settings` — valid for bundled bash. `setShellPath` persists and must not be used.
- Unconditional `shellPath` override would skip SDK Program Files Git discovery.
- Review: Cut 1 commits that change the patch or `pnpm-lock.yaml` must update `scripts/release-runtime.lock.json` (`sdkPatchSha256`, `pnpmLock.sha256`) in the same commit. `verify:quick` includes `verify:release-metadata`. Cut 2 overwrites those SHAs with the final 0.84.2 values. The PR still merges once.
- Review: after `clearSessionModel`, `reconcileIdleActiveSessionModel` must `buildSessionSnapshot`, assign `graph.sessionSnapshot`, and `server.emit("session.snapshot")` with unchanged revision.
- Review: PM spike success is Host `cross-spawn@7.0.6` plus a copied wait helper. There is no legal import of SDK `spawnProcess`.
- Review: product 0.2.2 lands in seven files plus a version-equality assert in `release-sdk-evidence.mjs`.

Product version for this PR is **0.2.2**. Do not ship `defaultTools` UI in the same change.

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| Audit via `npm pack`, not `pnpm add` | Keeps the 0.2.1 lock frozen until Cut 2. |
| Hybrid Cut 1 then Cut 2 in one PR | Bisectable Host migrations. Each commit that changes the patch/lock updates evidence SHAs; `main` only sees the final 0.84.2 pin because the PR merges once. |
| Sentinel instead of `model: null` | 0.84.2 auto-selects on empty model; PiDeck must not resurrect disabled Providers. |
| Dist patch for invocation ownership (session+runner+wrapper) | Per-handler and per-tool `sourceInfo` is not a public 0.84.2 hook. |
| PM adapters only if a timebox spike reproduces wait/signal/scope | Three spawn wrappers are not the current patch. |
| Migrate only `attachment-tool.ts` to `typebox` | Protocol does not depend on TypeBox; no need to rewrite `@pideck/protocol`. |
| `PI_SDK_PACKAGES` has seven entries | `pi-client` / `pi-protocol` are runtime protocol boundaries; `pi-telemetry` is pulled by `pi-ai` / `pi-agent-core`. |

## Issues Encountered
| Issue | Resolution |
|-------|------------|
| Extracting both tarballs into one `package/` overwrote coding-agent with pi-ai | Extract to sibling directories. |
| 0.84.0 changelog overstates in-process `message_update` breakage | JSON/RPC helper strips `partial`; AgentSession events still carry it. |
| `declare module` on `.../dist/core/extensions/types.ts` did not merge | Augment the package root `@earendil-works/pi-coding-agent`. `editor` merge is an overload; Host impl must type the third arg as optional. |
| `publishIdleActiveSessionSnapshot` copies current thinkingLevel | Tests that expect `"off"` must call `clearSessionModel` first. |

## Resources
- `%TEMP%\pideck-sdk-0842\coding-agent\package\dist`
- `%TEMP%\pideck-sdk-0842\pi-ai\package\dist`
- `docs/operations/pi-sdk-0.82.1-handoff.md`
- `docs/operations/pi-sdk-0.82.1-api-notes.md`
- `patches/@earendil-works__pi-coding-agent@0.84.2.patch`

### Cut 2 gate (2026-08-20)
`verify:quick`, `pnpm build`, `pnpm test:rust` (77), `pnpm lint:rust`, `package:sidecar:with-node`, `validate:resources`, and `smoke:staged-host` all passed on 0.84.2 / 0.2.2. Staged evidence: six Pi packages `0.84.2`, `bashProbe ok`, `gitStatus ready`, Host exit 0. Working tree is still uncommitted.

### Pre-merge review (2026-08-20)
External review: no blocking logic errors; two P2s before merge.

1. `THIRD_PARTY_NOTICES.md` still named coding-agent `0.80.7`. Updated to the six-package 0.84.2 family; `verify:release-metadata` now requires those names and the pin.
2. `sdk-invocation-runner.test.ts` constructed `ExtensionRunner` and called `setInvocationRunner` directly, so bind/reload patch hunks were untested. New AgentSession test binds only `invocationRunner`, reloads, and asserts trusted `sourceInfo` on the replacement runner.
3. P3: `chat-runtime.md` / `extension-presentation.md` no longer pin 0.82.1.
4. Follow-up: Knip unused `assertThirdPartyNotices` export — tests now import it. `pi-telemetry@0.84.2` added to `PI_SDK_PACKAGES`, evidence tree lookup (reachable `node_modules` links only), notices, and freshness list. Store-only orphans fail a negative fixture.

---

## Tools panel / defaultTools (design, 2026-08-20)

User asked how to productize tool toggles after the 0.84.2 bump. Not implemented.

### Two different APIs (do not collapse)

| | Live active tools | SDK `defaultTools` |
|---|-------------------|-------------------|
| What | Names currently on `agent.state.tools` | Initial **built-in** selection at `createAgentSession` |
| Mutate | `AgentSession.setActiveToolsByName` → Host `agent.setActiveTools` | `settings.json`; `SettingsManager.getDefaultTools()` only, **no setter** |
| Extensions | Can be turned off | Stay enabled (`includeAllExtensionTools: true`) |
| Scope | This AgentSession / runtime | Global `~/.pideck/agent/settings.json`. Project `.pi/settings.json` is **not** loaded (`projectTrusted: false`) |
| Survive idle dispose | No, unless Host re-applies something on recreate | Yes, for the next create’s builtins |

SDK `CreateAgentSessionOptions.tools` is a **strict allowlist** stored as `_allowedToolNames`. Do not use it for the GUI: later `setActiveTools` cannot enable names outside the list, and registry refresh re-adds every allowed name.

Built-in registry is seven tools (`read|bash|edit|write|grep|find|ls`). Default active is four (`read|bash|edit|write`). `grep`/`find`/`ls` exist but start off. Read-only preset should turn those three on when bash/edit/write go off.

### Already in PiDeck

- Protocol: `agent.getTools`, `agent.setActiveTools` (`{ names }`), event `agent.toolsChanged`, CAS `expectedToolRevision`.
- Host: idle + graph lock + session op lock; always unions `read_attachment`; publishes snapshot + event.
- Desktop: `store.tools` + `classifyToolSnapshot` (apply/drop/recover). **No UI calls the methods.**
- Docs already list a Tools panel in `chat-runtime.md`. UX review 2026-07-30: frontend zero-consumption.

### Host bug that blocks grouping

`getAllTools()` returns `{ name, description, parameters, promptGuidelines, sourceInfo }`. `buildToolSnapshot` reads `sourceLabel` / `source` / `source.kind`, so `SerializableToolInfo.source` is typically **undefined**. Builtins are `sourceInfo.source === "builtin"`. Fix mapping before the popover groups by source.

### CLI analog

Official example `examples/extensions/tools.ts`: `/tools` TUI SettingsList, persist via session custom entry `tools-config`. Requires TUI. PiDeck should ship a first-party `/tools` builtin (same pattern as `/session`) so that extension never has to run.

### Persistence recommendation (v1)

Workspace builtin preset in `DesktopSettings` (Full / Read-only / All-seven / Custom names). Host applies with `setActiveToolsByName` **after** create. Do not write `defaultTools` in v1 (no public setter; would fight workspace preset; CLI users can still open `settings.json` from Settings → General).

### Product decision (2026-08-20): do not ship

User: the panel is not worth building. Agreed.

Why the earlier design over-weighted it: UX review listed a hole, SDK 0.84.2 added `defaultTools`, and Host RPC already existed — that looks like “just consume it.” The real product is a coding agent with bash/edit/write on. A trustworthy read-only mode needs persistence, busy/CAS, source grouping, and pinned `read_attachment`; that is a feature, not a missing button.

Leave protocol/Host in place (snapshots, context-usage tokens, `addedToolNames`). Do not add UI, workspace presets, `/tools`, or a `defaultTools` settings page. Do not hitchhike the `source` mapping. Revisit only if a concrete user repeatedly needs “this repo must not bash.”

---

## Deck design (Extension UI rework, 2026-08-21) — HISTORICAL

**Historical.** `docs/architecture/deck.md` is a superseded whole-window pane
workspace alternative. The accepted target is
`docs/architecture/extension-deck.md`. Do not implement movable builtins,
session/workspace layouts, or absorbing Sidebar/RightDock.

Accepted target design was first written to `docs/architecture/deck.md`. Design only; no
implementation. User rejected patching the existing shells twice — the goal is
the end state, not a first batch.

### Locked product decisions
- App-level pane primitive: builtins (sessions/files/tree/changes/shells/browser)
  and Extension views are the same leaf type; `RightDock` and `Sidebar` get
  absorbed. Main-area splits in scope from day one.
- Views: `chat` (non-closable singleton), builtins, `ext.widget` (per
  origin:key), `ext.status`, `ext.terminal` (≤1), `ext.decision`. Notifications
  stay out (user decision) — toast stack unchanged.
- Renderer registry per view type; the `custom()` dual path (structured walk of
  known pi-tui trees vs xterm) becomes a registry entry.
- Default Deck reproduces today's window pixel-for-pixel; that is the cutover
  acceptance property.

### Facts dug out of source that shaped the design
- `extensionUi.widgetChanged` / `statusChanged` carry no trusted origin
  (`dto-validate.ts` exact-keys: widget/key/placement, text/key). Emit sites are
  `publishWidget` / `setStatus` in `extension-ui-bridge.ts`, where binding
  identity and the invocationRunner ambient invocation are in scope. Adding
  optional `origin` there is the ONLY protocol delta. Widgets/statuses replay
  from bridge state on rehydrate, so origin rides recovery for free.
- Native browser webviews (`browser_surface.rs`, child `Webview` map on the
  main window) composite above ALL HTML. Deck rules: native views never float;
  live native rects are float-drag exclusion zones; the modal layer hides
  native surfaces (`webview.hide()`) — fixes browser-over-modal as a side
  effect.
- Widget/status/terminal content is session-scoped (store clears on session
  switch); layout memory must be workspace-scoped, keyed by
  `ext:<originId>:<verb>[:<key>]`. Origin-less legacy events key on widget key
  alone, last-writer-wins.
- High-risk / session-lifecycle decisions stay modal by Host policy regardless
  of user layout; low-risk inline decisions may be re-homed (requests pane /
  float), keyed by origin, never requestId.
- What gets deleted: `ExtensionWidgetsPopover` + anchor geometry,
  `ExtensionUiModal` shell, `InlineExtensionUiRequest` mount, `RightDock` +
  `DockTabId`, `Sidebar` shell. What must not change: request ownership,
  epochs, decision groups, expiry queue advance, respond lifecycle,
  VirtualTerminal input/resize identity checks, routing policy.

### Build order (each batch green + shippable)
1. Deck core standalone (tree ops, DnD on pointer events, floats, keyboard,
   persistence, native zones) — heaviest, ~transcript-pipeline scale.
2. Extension views cut over (widget → terminal → decision; origin fields first;
   decision keeps a one-release legacy fallback).
3. Builtins migrate; browser last; one-time import of dock width/open prefs.

### pi-subagents compatibility walkthrough (2026-08-21)

Walked pi-subagents 0.50.0 (installed at ~/.pi/agent/npm) against the Deck
design. PiDeck reports `hasUI: true, mode: "rpc"`; the extension gates features
on `hasUI` (so everything activates) but branches its async-jobs widget on
`mode === "rpc"`.

Surface inventory → Deck mapping:

| Surface | Fact | Deck fit |
|---|---|---|
| FleetView table | `setWidget("subagent-fleet-status", factory, placement belowEditor)`, on by default | `ext.widget`, anchored default, promotable to float HUD — the original user scenario. Clears while inspector open and restores after; layout memory re-mounts it correctly |
| Async transport widget | rpc branch emits `["PI_SUBAGENT_ASYNC_JSON:{...}"]` (`shared/types.ts:2082` WIDGET_KEY "subagent-async"; encode at `async-status-snapshot.ts:275`) | **Finding 1**: PiDeck renders this raw today (no desktop filter exists despite the surfaces doc saying don't). Deck amplifies it (anchored strip default). Fix seam: renderer-selection rule classifying machine-transport content into a non-visual renderer — registry entry, not core routing. Info not lost (FleetView shows the same jobs) |
| Fleet inspector | `ui.custom<undefined>()` `fleet.ts:1288`, `overlay:true anchor:center width:95%`, guard `hasUI` only; stop-confirm drawn inside the component (`stopConfirming`, fleet.ts:710/863) | Opens in PiDeck (xterm, keyboard forwarded). Deck: `ext.terminal`, floatable/splittable. **Finding 2**: overlay hint suggests centered-float default; needs optional `overlay?: boolean` on the customOpened event (2nd protocol delta, user to approve) |
| Dialogs | select/confirm/input/editor across stop picker, admin flows, watchdog | `ext.decision`; command-origin groups give multi-step admin flows one card shell; event-origin watchdog confirms stay single |
| Status | `setStatus("subagent-slash", ...)` | `ext.status` |
| Doctor / supervisor | renderer + hidden message; customType adapter | transcript-owned; Deck leaves untouched |
| notify | failure/pause | out of Deck (user decision) |

**Finding 3 (pre-existing, not Deck's fault):** inspector entry channels
narrow in PiDeck — widget arrow keys dead (`onTerminalInput` no-op),
`ctrl+alt+f` dead (`registerShortcut` has zero Host consumers; only
`session.getCommands` surfaces commands). Only `/subagents-fleet` works.
Deck's pane-command seam could later host per-view actions.

Input-routing detail verified: Esc inside the xterm fleet panel stays with the
extension component (`chat.stop` lacks `worksInTerminal`, keymap gates `.xterm`
targets), so the in-component confirm flow is not shadowed.

**Verdict: the design holds.** Every surface maps to an existing view type;
both real frictions land on seams the design already has (renderer selection,
one optional event field). No architectural change required. Amendments 1–2
await user approval before editing deck.md.

---

## Extension Deck (accepted target, 2026-08-22)

Authoritative design: `docs/architecture/extension-deck.md`.
`docs/architecture/deck.md` is historical and must not be implemented.

Batch 1 source facts used for the vertical contract:

- Widget/status/custom events now carry optional trusted `origin` (same union as
  `ExtensionUiRequest.origin`). `customStarted` also copies `overlay?: boolean`.
- Host captures origin at `setWidget` / `setStatus` / `custom()` time, not at
  deferred render or replay. Clear reuses the saved live-key origin.
- Production `getTrustedPackageOrigin` stays unset: the shared UI context cannot
  know a package without guessing from keys/titles/paths.
- Host default before hello/configure is `legacy-modal` + empty override map.
- Configure overrides are optional on the wire so old Desktop stays valid;
  omitted overrides keep the current map; `{}` replaces atomically.
- `HostStatusSnapshot` does not grow an overrides field (old Desktop exact-key
  `host.statusChanged` / hello result).
- Desktop observes trusted-origin events only; first Extension/family pair
  writes once; replay/clear do not write or delete observations.
- Desktop projects only `extensionDecisionPresentation` + dialog overrides to
  Host. Float/Dock/capabilities stay in `DesktopSettings.extensionUi`.
- Rust `extensionUi` deserializes through a sanitizer that cannot fail the
  parent `DesktopSettings` parse. Unknown version resets only the nested field.

Batch 3/4 leftovers (not product-scope cuts):

- `extension-deck-v1` rollback path is intentionally kept for one release.
- Production `getTrustedPackageOrigin` remains unset; unknown origins render
  with defaults and cannot create profiles.
- `dock.secondaryEnabled` is persisted but live layout uses each slot's
  `home.group`; the flag is not a third layout engine.
- Float display names fall back to the raw `extensionId` until
  `rememberExtensionDisplayName` has seen a trusted origin.
- Host `oauth-refresh-compat` can EPERM-rename `auth.json` under parallel
  Windows load; isolated reruns pass. Not part of Extension Deck.

### Acceptance audit (2026-08-22, current tree)

| # | Result | Evidence |
|---|---|---|
| 1 | pass | `ExtensionDock.dom.test.tsx` hides `Extensions` with no docked content |
| 2 | pass | Builtin RightDock/Sidebar/Chat commands unchanged; Files never enter Extension groups |
| 3 | pass | `extension-ui-resolver.test.ts` + `[data-widget-popover]` absent; popover component removed |
| 4 | pass | `ExtensionUiSettingsSection.dom.test.tsx` observed families + legal options + empty hint |
| 5 | pass | Widget persist without Host configure; blocking `extensionUi.configure`; published request stays inline |
| 6 | pass | Float drag/pin Undo toast “Applies to all sessions”; `extension-ui-profile.test.ts` |
| 7 | pass | Session switch hides content and leaves the saved family home |
| 8 | pass | Empty dock/float/anchors unmount; custom/dialogs have no hidden home |
| 9 | pass | Two-group cap + edge drop; no third group; no Files in groups |
| 10 | pass | `extension-ui-policy.test.ts` high-risk/lifecycle stay modal |
| 11 | pass | `browser-occlusion` refcount + float `excludeBrowserRect`; Web stays a builtin tab |
| 12 | pass | Rust nested sanitizer + protocol sanitize; parent DesktopSettings not quarantined |
| 13 | pass | `extension-ui-observation.test.ts` replay/clear do not write again |
| 14 | pass | Host `user-extension-*` reasons; inline preference cannot override mandatory modal |
| 15 | pass | Gate off = legacy request tabs; gate on = one `extensions` tab; rollback keeps builtin prefs |
| 16 | pass | `FAMILY_PRESENTATION_CHOICES.blockingDialog` is followHost/inline/modal |
| 17 | pass | Status choices are above-composer / Dock / hidden |
| 18 | pass | Observation maps only widget/status/custom/request |

## Extension UI review fixes (2026-08-22)

Review of commit `40e1bad` found seven implementation gaps behind the accepted design:

- New Dock/Float custom close buttons only deliver Escape; unlike the legacy
  RightDock path, they never force-settle a component that ignores Escape.
- `ExtensionDockArea` and `ExtensionFloatLayer` temporarily unmount live Xterm
  surfaces. Xterm cleanup clears the frame bus while Host continues emitting
  differential frames, so remount can lose/corrupt the screen.
- `persistExtensionUiSettings` evaluates its functional updater before the
  global write queue. Concurrent observations/profile edits can derive from
  the same snapshot and overwrite one another with whole-setting writes.
- A docked `custom()` opens RightDock but does not reliably activate the
  Extensions page, especially when another docked family already exists.
- Dock group selection keeps removed/moved slot IDs and can leave every panel
  hidden.
- Float pixel geometry is initialized once, so Undo/profile updates and
  viewport resizing do not rehome/clamp the live shell.
- Float drop hit-testing sees the dragged shell itself, preventing drops onto
  composer anchors beneath it.

## Extension UI second review (2026-08-22)

- The serialized `persistExtensionUiSettings` updater can still be bypassed by
  `commitExtensionUiSettings(() => input.next)`, because profile/layout callers
  precompute a whole snapshot before their turn reaches the queue.
- Keeping Float custom terminals mounted while Settings is open means the
  existing mount-only focus effect can retain focus inside a hidden Xterm or
  focus a hidden dialog when a request starts behind Settings.
- Dock and Float close buttons have no pending state; repeated clicks can start
  duplicate Escape/force flows and surface a stale-response error after another
  flow already closed the request. Their error path also mislabels Host close
  failures as desktop-settings save failures.
# Detached Float resize re-attach diagnosis (2026-09-01)

- User-visible symptom: while resizing an independent Extension Float by its OS
  window border, after dragging for a while the surface automatically returns
  to the main window's `aboveComposer` anchor form.
- Live dev output contains no Host/runtime error at the time of the gesture;
  the behavior is therefore likely in the Desktop detached-window lifecycle,
  not an Extension handler crash.
- Source search shows only two intended ways to remove `home.detached`: an
  explicit re-attach/move intent, or detached placement reconciliation returning
  `reattach` for `no-monitors` / `monitor-missing`. The resize gesture should
  emit only a debounced `geometry` intent, so monitor reconciliation is the
  leading hypothesis until the exact event chain is proven.
- The controller polls `extension_float_monitors` every 2 seconds. A thrown IPC
  error becomes `null` and preserves the previous topology, but a successful
  empty array replaces it. On the next reconcile, `resolveDetachedPlacement`
  returns `reattach/no-monitors`, removes the slot from `wanted`, closes the OS
  window, and republishes it to the in-window float layer. This timing matches
  “resizing for a while” crossing a polling tick.
- Rust calls `app.available_monitors()` and returns its vector unchanged. The
  command was already made synchronous because macOS had previously returned an
  empty vector off the main thread; neither Rust nor Desktop currently requires
  a second consecutive empty sample before treating it as real topology loss.
- Geometry settings writes are serialized by `settingsWriteQueue`, and each
  updater reads the latest store snapshot only after prior writes settle. A
  stale concurrent geometry write is therefore not the likely cause.
- The active native settings file is a `{schemaVersion, settings}` envelope.
  The initial `anchor/aboveComposer` profile belonged to
  `@narumitw/pi-plan-mode`, not the window the user was resizing. The clean
  reproduction identified the affected Float as `@juicesharp/rpiv-todo`.
- Neither the `geometry` intent handler nor sanitizer can manufacture an anchor:
  geometry spreads a currently-live float home and replaces only `detached`;
  invalid homes are removed, after which resolver defaults may render above the
  composer but would not persist an explicit anchor object.
- Undo timeout only calls `clearExtensionUiUndo()`; it never runs
  `undoExtensionUiSettings()`. Automatic timeout is not the writer.
- The Float intent relay preserves the `kind` field and only overwrites
  `slotId`; a geometry payload cannot be misclassified as `setPlacement` by
  Rust. `FloatWindowRoot` emits `setPlacement` only from its placement-menu
  item callbacks.
- Extension observation records only capabilities/display names. Resolver
  defaults can choose `aboveComposer` when no saved profile exists, but neither
  observation nor resolution persists that default. Extension widget updates
  and placement hints cannot overwrite a legal saved float profile.
- The clean reproduction captured 17 profile changes over roughly 81 seconds.
  Every change retained `kind: "float"`, the same detached monitor descriptor,
  and the newly reported rect. No anchor transition, explicit placement, Undo,
  or invalid geometry occurred. Resize persistence is behaving correctly.
- Both detach entry points await monitor resolution and then persist the full
  float+detached home before the controller opens the native window. A normal
  successful detach therefore cannot be merely in-memory.
- Title-bar controls stop pointer-down propagation, so clicking the placement
  button cannot also start the native title-bar drag. Border resize itself has
  no React handler that opens the placement menu.
- The production `commitExtensionPresentationHome` call graph contains no
  timer-driven anchor writer: explicit commands/context menus/drop targets,
  Float intents, Dock moves, and settings reset are the only callers. Controller
  reconciliation intentionally performs no write when a monitor disappears.
- Combined conclusion: the intermittent disappearance is most plausibly the
  monitor poll accepting one transient successful `[]` sample as real topology
  loss. That branch closes the OS window and republishes the Float in the main
  window without changing the saved detached profile, matching both the user's
  perception and the absence of any anchor write in a clean resize trace.

# Anchor placement-control UI findings (2026-09-01)

- Above/below Composer surfaces are inline content, so persistent drag chrome
  creates an unnecessary mini-window hierarchy and competes with the content.
- Removing the drag gesture also removes a nested gesture conflict. Placement
  remains fully expressible through one semantic menu button and the existing
  context-menu/command paths.
- Progressive disclosure is appropriate on desktop, but the layout button must
  become visible on both container hover and `focus-within`; its own focus ring
  must remain visible so keyboard users never depend on hover.
- Compact menu target: short destination labels, one consistent outline icon
  column, current-state indication, and reduced padding/width without changing
  semantic tokens or focus management.
- `AnchorSlotRow` owns the redundant grip and all anchor-origin pointer-drag
  lifecycle; removing that block does not affect Float title-bar movement or
  the global drop overlay used by Floats.
- The shared `Menu` is currently fixed at `min-w-48` with 32px-plus rows. A
  request-level compact density keeps other application menus unchanged while
  allowing the placement menu to be narrower and tighter.
- Placement choices currently omit the active destination and have no icons.
  A selected, disabled current row plus destination icons gives orientation
  without making the menu chrome heavier.

# Structured widgets implementation findings (2026-08-30)

- Desktop widget content converges on `ExtensionWidgetContent` /
  `ExtensionWidgetRows`; selecting the structured form there can cover Anchor,
  Dock, attached Float, and detached Float without coupling the payload to a
  presentation home.
- `extensionUi.widgetChanged.widget` is already `JsonValue`; structured
  publication needs no new outbound event. Unknown/non-matching payloads stay
  on the existing read-only renderer path.
- The inbound action path should mirror `extensionUi.customInput` end to end:
  Protocol request/result validation, Desktop session-target request, Server
  active-session/epoch gate, then bridge-owned delivery to the trusted binding.
- The SDK adapter currently augments `ExtensionUIContext`; this is the seam for
  the bridge-owned per-widget action registration declaration.
- Widget rows retain both the published key and trusted `origin`; Desktop can
  therefore dispatch `{key, actionId}` using its existing active-panel session
  context without adding origin to the untrusted request body.
- Bridge widget state is already keyed by `liveStateIdentity(key, origin)` and
  preserves the publisher origin through replacement/clear. The action handler
  registry should use the same storage key so equal public keys from separate
  Extensions cannot collide.
- `createExtensionUiContext` owns cleanup and currently has a no-op
  `onTerminalInput`; adding `onWidgetAction(key, handler)` beside it keeps the
  registration lifecycle within the binding and makes cleanup deterministic.
- `SessionTargetMethod` is the shared Protocol classification for respond,
  custom input, and custom resize. Adding widgetAction there gives it the same
  concrete session-generation context; Host `factory.checkIdentity()` then
  rejects stale workspace/session revisions before bridge delivery.
- Action validity cannot be inferred only in Desktop: Host must retain the
  action ids parsed from the last live structured payload for the same
  `extensionId + key`, then require both a live payload action id and a live
  handler at dispatch time.
- UI/UX rules for the structured renderer: preserve DOM/visual tab order,
  provide visible focus rings, confirm destructive or explicitly-confirmed
  actions, expose an async pending state, and catch/report dispatch failures.
  Buttons must remain host-owned and use existing semantic tokens; no payload
  style may bypass PiDeck's accessible control system.
- PiDeck already has a shared modal `Dialog` with focus handling, Escape,
  semantic warning/danger tones, and standard buttons. Structured action
  confirmation should reuse it instead of `window.confirm` or an ad hoc popover.
- Dispatch failures already have a consistent surface through
  `useAppStore.getState().pushNotification(..., "error")`; action buttons can
  remain locally pending/disabled while the request is in flight and report
  transport/Host errors through that channel.
- Detached Float windows reuse `ExtensionWidgetRows` but intentionally have no
  Host client/session state. The renderer must accept an injected action
  dispatcher: attached homes call Host directly with the active session
  context; detached homes emit a `widgetAction` intent for the main-window
  controller to validate and forward.
- The main-window Float controller already resolves the current slot/mount for
  each intent. It should require that the addressed mount contains the widget
  key and a currently enabled structured action before forwarding; Host remains
  the authoritative second validation layer.
- Structured parsing belongs before the existing `form === strip/panel`
  fallback branch. A successful parse renders the same host-owned rows in every
  home; a null parse preserves the current strip summary, panel/list, ANSI
  stripping, and object fallback behavior byte-for-byte.
