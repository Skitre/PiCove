---
description: Extension Deck UI 体验打磨（分阶段执行：quickfix / A / B / C）
argument-hint: [quickfix|A|B|C|all|status]
model: claude-sonnet-5
---

# Extension Deck UI 体验打磨

阶段参数：`$ARGUMENTS`

- 为空：读 `progress.md` 里「UI polish」相关条目，找到下一个未完成阶段，**只执行那一个**然后停下；若还没有任何「UI polish」条目，从 quickfix 开始。
- `quickfix` / `A` / `B` / `C`：只执行指定阶段。
- `all`：按 quickfix → A → B → C 顺序全部执行。
- `status`：只汇报各阶段完成情况（依据 progress.md 与源码抽查），不做任何修改。

## 背景（你没有先前对话的上下文，以下即全部所需）

PiDeck 是基于 Tauri + React 的 Pi coding agent 桌面端，pnpm monorepo：`apps/desktop`（React UI + `src-tauri` Rust）、`packages/protocol`、`packages/pi-host`。

「Extension Deck」——Extension UI 的展示层（composer 锚点、浮窗层、RightDock 里的 Extensions 区、Host 模态层、每扩展全局展示偏好）——已按 `docs/architecture/extension-deck.md` 完整落地，测试全绿。**该文档是唯一权威设计；`docs/architecture/deck.md` 是被否决的历史方案，绝不可照它实现。** 本任务是在已完成实现之上做纯 Desktop 层的 UI 体验打磨。

动手前通读 extension-deck.md 这些小节：Extension surface model、Renderer registry、Float layer、Dragging edits global Settings、Non-goals。

核心现有模块（均在 `apps/desktop/src`）：

- `lib/extension-ui-slots.ts` — 把 live widget/status/custom 组装成 presentation slot（`buildExtensionPresentationSlots`、`mountsForHome`；每个 mount 自带 `home`）。
- `lib/extension-ui-resolver.ts` — 纯 resolver（profile → hint → default），含 float 上限回落。
- `lib/extension-ui-profile.ts` — `commitExtensionPresentationHome` / `commitExtensionUiSettings`（队列化写入 + Undo 快照）。
- `lib/extension-ui-presentation.ts` — `FAMILY_PRESENTATION_CHOICES`、choice ↔ home 映射、合法性判断。
- `lib/extension-ui-observation.ts` — 观察记录；`observeExtensionUiFamily` 仅在首次入库时返回 `true`（重放/重复为 `false`）。
- `lib/extension-ui-float-geometry.ts` — 浮窗几何、clamp、`readBrowserExclusionRect`。
- `features/extensions/ExtensionPresentationMounts.tsx` — 锚点槽、状态条、浮窗壳、Undo toast；浮窗指针拖拽与 `homeFromDropTarget` 落点判定在此。
- `features/extensions/ExtensionDockArea.tsx` — Dock 双分组（HTML5 DnD、末尾 `data-extension-dock-edge="secondary"` 边缘落点、role=separator 分隔条）。
- `features/extensions/ExtensionWidgetContent.tsx` — `ExtensionWidgetRows` / `ExtensionStatusRows`（目前所有位置共用同一渲染：`renderWidget` → `<pre>` + `JSON.stringify`）。
- `lib/browser-occlusion.ts` — module store + `useSyncExternalStore` 的范例模式。
- `lib/context-menu.ts` — `openContextMenu` 基建（接线方式参考 `lib/text-context-menu.ts`、`lib/context-menu-policy.tsx`）。
- 挂载点：`features/chat/Composer.tsx`（两个锚点 + 状态条）、`features/chat/ChatPage.tsx`（浮窗层 + Undo toast）、`components/RightDock.tsx`（Extensions tab）。

## 硬约束（违反任何一条即任务失败）

1. 只改 `apps/desktop/src/**` 的 TS/TSX。禁止改 `packages/protocol`、`packages/pi-host`、`apps/desktop/src-tauri`、`patches/`、lockfile。若某步看似必须改这些 → 停下汇报，不要动手。
2. 不新增任何持久化设置字段（那需要跨 protocol/Rust 边界）。新的 UI 状态一律内存态。
3. 只在 `extension-deck-v1` 开启路径上工作；不碰 `RightDock.tsx` 里 gate 关闭时的 legacy `extension:${requestId}` 分支。
4. 行为不变量（源自文档验收标准，已有测试守着）：
   - 位置持久化只发生在完成的 drop/resize 或明确的菜单/设置操作上，永不在 pointer move 中连续写。
   - 所有移动一律走 `commitExtensionPresentationHome`（自带 Undo toast 与 “Applies to all sessions”）。
   - 浮窗 z-order 是短暂状态，绝不持久化。
   - 阻塞对话框与存活的 custom() 永不隐藏或不可达；widget 内容保持只读，不新增输入语义。
   - 无空 chrome：空的浮窗 / Dock tab / 锚点块必须完全不挂载。
   - family 合法性以 `FAMILY_PRESENTATION_CHOICES` / `isPresentationHomeForFamily` 为准。
5. i18n：所有用户可见文案走 `useT` / `tCurrent`，key 同时加进 `lib/i18n/en.ts` 和 `lib/i18n/zh.ts`。
6. 无障碍与动效遵循现有模式（role / aria-label / focus-visible / `motion-reduce:` 变体）。
7. 每个改动配套就地测试（`.test.ts` 单测 / `.dom.test.tsx` DOM 测试）。`ExtensionDock.dom.test.tsx`、`ExtensionPresentation.dom.test.tsx` 定义了既有预期行为——如与本文规格冲突，停下汇报，不许删改测试硬闯。

## 环境与命令

- 本机 `pnpm` 必须先注入 fnm：`eval "$(fnm env --shell bash)" && pnpm <cmd>`。
- 聚焦测试在 `apps/desktop` 内以相对路径运行（workspace 相对路径匹配不到文件）：
  `eval "$(fnm env --shell bash)" && pnpm -C apps/desktop exec vitest run src/lib/xxx.test.ts`
- 阶段收尾门槛：`eval "$(fnm env --shell bash)" && pnpm verify:quick` 全绿。本任务不涉及 Rust，无需 lint:rust / test:rust。
- 提交：每完成一个工作项提交一次，风格照 git log（`feat(desktop): ...` / `fix(desktop): ...`），作者 Skitre，**绝不添加任何 Co-Authored-By / Generated-with 尾注**。
- 每阶段结束后按 `progress.md` 既有格式追加条目，标题形如 `## Session: <日期> UI polish <阶段>`，供下次 `/goal` 判断进度。

## Phase quickfix — 三个独立小修（各自单独提交）

### QF1 PI_SUBAGENT 传输行过滤

- 依据：extension-deck.md「Renderer registry」要求匹配 `^PI_SUBAGENT_.*_JSON:` 的内容走非可视兼容渲染。这是现役 bug：pi-subagents 在 rpc 模式下 async widget 会把裸传输 JSON 行显示出来。
- 做法：新建纯函数模块 `lib/extension-ui-transport-filter.ts`——string 按行过滤 `/^PI_SUBAGENT_.*_JSON:/`，全部被过滤视为空；`string[]` 逐元素同理；非字符串内容原样返回。status 文本用同样的单行判断。
- 接入：优先在 `buildExtensionPresentationSlots` 组装前过滤，使「内容全是传输行」的 widget 不产生任何可见行，且槽内全空时锚点块 / Dock tab / 浮窗完全不挂载。
- 边界：这是临时兼容，不要泛化为通用渲染协议（文档原话）；不影响 observation（观察在事件入口，与渲染无关）。
- 测试：helper 单测（混合行 / 全传输行 / 数组 / 非字符串不动）+ slot 级测试（全传输行 → 无 mount）。

### QF2 浮窗点击置顶

- 现状：`ExtensionPresentationMounts.tsx` 里浮窗 z 序完全由渲染顺序决定，重叠时无法置顶。
- 做法：浮窗层维护内存态递增计数；shell 的 `onPointerDownCapture` 把自己置为最大 `zIndex`（inline style）。新出现的浮窗默认最上。绝不持久化。
- 测试：DOM——两个浮窗，pointerdown 下层者，断言 zIndex 反超。

### QF3 拖拽落点高亮

- 现状：所有 `[data-extension-drop]` 目标在拖拽中零反馈；最糟的是 `ExtensionDockArea.tsx` 末尾那个启用次分组的边缘落点（`data-extension-dock-edge="secondary"`，8px 空 div）完全不可见，用户无从发现双分组功能。
- 做法：新建 `lib/extension-ui-drag-state.ts`（照 `browser-occlusion.ts` 的 module store + `useSyncExternalStore` 模式），保存 `{ slotId, family } | null`。设置时机：Dock 内 HTML5 dragstart、浮窗标题栏 pointer 拖拽开始；清除：dragend / drop / pointerup / pointercancel 所有路径（含取消）。
- 拖拽激活时按被拖 family 点亮合法目标（widget → 两个锚点 + dock 主/次；custom → 仅 dock 主/次），用现有 token（accent ring / `bg-accent/10`）；次分组边缘落点在拖拽中加宽（约 w-6）并显示 accent 条，使其明显可见。
- 测试：drag-state 单测 + DOM 测试（dragstart 后边缘落点高亮，dragend 清除）。

## Phase A — widget/status 渲染形态分化（strip vs panel/list）

依据：文档「Renderer registry」——widget 在锚点用 `strip`、在 Dock/Float 用 `panel`；status 锚点 `strip`、Dock `list`。现状是所有位置共用同一 `<pre>` 渲染，形态区分不存在。这是 V1 唯一没做完的部分，不算新增范围。

1. 纯函数 `lib/extension-ui-renderer-form.ts`：`rendererFormFor(family, homeKind)` → `"strip" | "panel" | "list"`，单测覆盖全组合。渲染处（`ExtensionPresentationMounts.tsx` 的 `SlotBody`、`ExtensionDockArea.tsx` 的面板）已能拿到 `mount.home`，把 form 传给 `ExtensionWidgetRows` / `ExtensionStatusRows`。
2. strip（锚点）：每个 widget 一行紧凑摘要（渲染内容的首个非空行，单行截断），点击展开/收起，复用现有 `collapsedExtensionWidgetKeys` store，不改其持久化；展开后维持锚点现有的有界高度语义。
3. panel（Dock/Float）：按形状结构化——string → 文本行；`string[]` → 行；纯 primitive 值的对象 → 键值行（dl 风格）；其余回退现有 `<pre>`。渲染前剥 ANSI 转义（desktop 没有现成 helper，新建小工具，正则参考 `features/chat/markdown-utils.ts` 里那条）。
4. status 在 Dock 用 list 形态（key + text 成行，允许换行）；锚点 chip 条（`ExtensionStatusChipRail`）不动。
5. 排版 pass：panel 正文 ≥11px，层级用现有 token（text-muted / bg-surface-*），不引入新颜色；widget 保持只读，不得出现可聚焦或可输入内容。

测试：form 单测；DOM——锚点显示摘要行并可展开；Dock/Float 对象 widget 渲染键值行；Dock status 渲染 list；ANSI 被剥除。

## Phase B — 移动交互（先 B0 后 B1，分开提交）

### B0 槽位右键菜单（风险最低，先做）

在槽位 chrome（锚点 slot 行、Dock tab、浮窗标题栏）接 `openContextMenu`。菜单项 = 该 family 的合法去处（`FAMILY_PRESENTATION_CHOICES` 经 `presentationHomeFromChoice` 映射），排除当前位置；hidden 仅对 widget 提供；持久化走 `commitExtensionPresentationHome`（自动获得 Undo toast）。文案 i18n 两个文件都加。

### B1 锚点拖出

`ExtensionAnchorSlots` 目前只是 drop 目标，而 widget 默认位置恰好是锚点——文档开篇「把 FleetView 拖进 Dock」的鼠标路径走不通。这是本阶段核心。

- 每个锚点 slot 行加拖拽把手（grip 图标区）；pointer 拖拽照浮窗现有模式（pointer capture + document 监听 + `elementFromPoint` 命中 `data-extension-drop`；把 `ExtensionPresentationMounts.tsx` 里的 `homeFromDropTarget` 抽成共享 helper）。
- 关键：拖拽期间显示带文字的落点浮层（fixed overlay），因为 RightDock 可能收起或停在别的 tab，不能依赖真实 Dock 可见。浮层给出该 family 合法的大目标：「Dock 主组 / Dock 次组 / 输入框上方 / 输入框下方」；落在空白处 = 在指针处按默认尺寸创建 float（参考浮窗现有 360×240 fallback），rect 经现有 clamp。与 QF3 的高亮状态整合。
- 只在完成的 drop 上写一次；中途取消（Esc / pointercancel）零写入。
- **不要重写 Dock 内部的 HTML5 DnD**（tab 重排、边缘落点有测试且工作正常）；B1 只为锚点新增指针路径，可顺带让浮窗拖拽也命中新浮层目标。

测试：DOM——菜单项按 family 合法且点击后 home 持久化、Undo 可回退；把手拖到 Dock 目标持久化 `{kind:"dock"}`；拖到空白创建 float 且 rect 被 clamp；取消拖拽零写入。

## Phase C — 可发现性提示

- 目标：用户不进 Settings 就不知道位置可配。首次观察到某个 Extension 时给一次性提示。
- 接缝：`lib/extension-ui-observation.ts` 的 `observeExtensionUiFamily` 恰在首次入库时返回 `true`。规则：仅当该 extensionId 此前完全没有 observedCapabilities 条目（首个 family）时提示一次，避免一个扩展弹四次。
- 呈现：复用现有通知（app-store 的 `pushNotification(message, kind)`，用法参考 `ExtensionDockArea.tsx`），文案类似「{name} 的界面位置可以自定义，在 设置 › Extension UI 中调整」；若现有基建支持动作按钮则加「打开设置」（设置页导航在 app-store 找现成的 page 切换），不支持就纯文案，不要为此新造 toast 系统。
- 不新增持久化字段：一次性语义由 observedCapabilities 的持久化天然保证（「Forget UI settings」后再见会再提示一次，可接受，报告里注明）。
- 测试：首次观察触发一次；重放 / 同扩展第二个 family 不触发。

## 每次运行结束的报告格式

- 完成了哪个阶段，每项一句话；
- 跑过的测试命令与数字（通过/失败原样报告，失败不许说成通过）；
- 提交列表（hash + message）；
- 与本规格的任何偏差及原因；
- 下一个未完成阶段是什么。

## 遇阻即停（汇报而不是硬做）

- 需要改 protocol / pi-host / src-tauri / patches；
- 需要新增持久化字段；
- 与 extension-deck.md 验收标准或现有测试冲突；
- `verify:quick` 出现与本任务无关的既有失败（报告即可，不要顺手修不相关的东西）。
