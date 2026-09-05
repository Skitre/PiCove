import { code } from "@streamdown/code";
import { cjk } from "@streamdown/cjk";
import { createMathPlugin } from "@streamdown/math";
import { createMermaidPlugin } from "@streamdown/mermaid";
import {
  type ComponentProps,
  cloneElement,
  Component,
  isValidElement,
  memo,
  type ReactElement,
  type ReactNode,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import remarkBreaks from "remark-breaks";
import remarkMathExtended from "remark-math-extended";
import {
  type Components,
  defaultRemarkPlugins,
  defaultRehypePlugins,
  type ExtraProps,
  type MermaidErrorComponentProps,
  Streamdown,
} from "streamdown";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  PanelRightOpen,
  RotateCw,
} from "lucide-react";
import {
  codeLineCount,
  deferIncompleteMermaid,
  isSafeExternalUrl,
  isSafeFootnoteFragment,
  mermaidFenceSignature,
  sanitizeAgentText,
  sanitizeMermaidSvg,
} from "./markdown-utils";
import { openChatLink, type ChatLinkActivation } from "./chat-link";
import { useT, type Translate } from "../../lib/i18n/use-t";

type MarkdownMessageProps = {
  content: string;
  mode?: "streaming" | "static";
  showCaret?: boolean;
  className?: string;
};

type CodeChildProps = {
  children?: ReactNode;
  className?: string;
  "data-block"?: string;
};

type MarkdownPreProps = ComponentProps<"pre"> & ExtraProps;
type MarkdownImageProps = ComponentProps<"img"> & ExtraProps;
type MarkdownLinkProps = ComponentProps<"a"> & ExtraProps;

type MarkdownRenderBoundaryProps = {
  children: ReactNode;
  fallback: ReactNode;
};

type MarkdownRenderBoundaryState = {
  failed: boolean;
};

class MarkdownRenderBoundary extends Component<
  MarkdownRenderBoundaryProps,
  MarkdownRenderBoundaryState
> {
  state: MarkdownRenderBoundaryState = { failed: false };

  static getDerivedStateFromError(): MarkdownRenderBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error): void {
    // Syntax highlighting is optional; keep the transcript usable when its
    // lazy chunk is stale or unavailable during a Vite update.
    console.warn("PiCove Markdown enhancement failed; using plain text", error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const CODE_COLLAPSE_THRESHOLD = 16;
const mathPluginBase = createMathPlugin({
  errorColor: "var(--color-muted)",
  singleDollarTextMath: true,
});
const mathPlugin: typeof mathPluginBase = {
  ...mathPluginBase,
  remarkPlugin: [
    remarkMathExtended,
    { singleDollarTextMath: true },
  ] as unknown as typeof mathPluginBase.remarkPlugin,
};
const mermaidConfig = {
  fontFamily: "var(--font-mono)",
  htmlLabels: false,
  securityLevel: "strict" as const,
  startOnLoad: false,
  suppressErrorRendering: true,
  theme: "neutral" as const,
};
const baseMermaidPlugin = createMermaidPlugin({ config: mermaidConfig });
const mermaidPlugin: typeof baseMermaidPlugin = {
  ...baseMermaidPlugin,
  getMermaid(config) {
    const instance = baseMermaidPlugin.getMermaid(config);
    return {
      initialize: instance.initialize,
      async render(id, source) {
        const result = await instance.render(id, source);
        const svg = sanitizeMermaidSvg(result.svg);
        if (!svg) throw new Error("Mermaid returned invalid SVG");
        return { ...result, svg };
      },
    };
  },
};
const markdownPlugins = { code, cjk, math: mathPlugin, mermaid: mermaidPlugin };
const remarkPlugins = [...Object.values(defaultRemarkPlugins), remarkBreaks];

type RehypePlugin = NonNullable<ComponentProps<typeof Streamdown>["rehypePlugins"]>[number];
type PluginWithOptions = readonly [unknown, Record<string, unknown>];
type HastLikeNode = {
  properties?: Record<string, unknown>;
  children?: HastLikeNode[];
};

const defaultSanitize = defaultRehypePlugins.sanitize as unknown as PluginWithOptions;
const configuredSanitize = [
  defaultSanitize[0],
  { ...defaultSanitize[1], clobberPrefix: "" },
] as unknown as RehypePlugin;
const rehypePlugins = [configuredSanitize, defaultRehypePlugins.harden] as RehypePlugin[];

function createFootnoteIdPlugin(prefix: string): RehypePlugin {
  const labelId = `${prefix}footnote-label`;
  return () => (tree: HastLikeNode) => {
    const rewriteDescribedBy = (value: unknown): unknown => {
      if (typeof value === "string") {
        return value
          .split(/\s+/)
          .filter(Boolean)
          .map((id) => (id === "footnote-label" ? labelId : id))
          .join(" ");
      }
      if (Array.isArray(value)) {
        return value.map((id) => (id === "footnote-label" ? labelId : id));
      }
      return value;
    };

    const visit = (node: HastLikeNode) => {
      const properties = node.properties;
      if (properties) {
        if (properties.id === "footnote-label") properties.id = labelId;
        if ("aria-describedby" in properties) {
          properties["aria-describedby"] = rewriteDescribedBy(properties["aria-describedby"]);
        }
        if ("ariaDescribedBy" in properties) {
          properties.ariaDescribedBy = rewriteDescribedBy(properties.ariaDescribedBy);
        }
      }
      for (const child of node.children ?? []) visit(child);
    };

    visit(tree);
  };
}

function ImageFallback({ alt, title }: MarkdownImageProps) {
  const t = useT();
  const label = alt?.trim() || title?.trim();
  return label ? (
    <span className="inline-flex rounded-md bg-surface-overlay px-2 py-1 text-xs italic text-muted">
      {t("markdownImageLabel", { label })}
    </span>
  ) : null;
}

function safeLink(
  { children, href, title, node, target: _target, rel: _rel, ...props }: MarkdownLinkProps,
  footnotePrefix: string,
  t: Translate,
) {
  const footnoteHref =
    typeof href === "string" &&
    isGeneratedFootnoteLink(node) &&
    isSafeFootnoteFragment(href, footnotePrefix)
      ? href
      : null;
  if (footnoteHref) {
    return (
      <a {...props} href={footnoteHref} title={title}>
        {children}
      </a>
    );
  }

  const safeHref = typeof href === "string" && isSafeExternalUrl(href) ? href : null;
  if (!safeHref) {
    return <span className="text-foreground underline decoration-border">{children}</span>;
  }
  return (
    <a
      {...props}
      href={safeHref}
      title={title ?? t("markdownOpenInDockBrowser", { url: safeHref })}
      onClick={(event) => {
        event.preventDefault();
        openChatLink(safeHref, event);
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        openChatLink(safeHref, event);
      }}
    >
      {children}
      <PanelRightOpen className="ml-1 inline size-3" aria-hidden="true" />
    </a>
  );
}

function isGeneratedFootnoteLink(node: unknown): boolean {
  const properties =
    node && typeof node === "object" && "properties" in node
      ? (node as { properties?: Record<string, unknown> }).properties
      : undefined;
  return Boolean(
    properties && ("dataFootnoteRef" in properties || "dataFootnoteBackref" in properties),
  );
}

function MermaidError({ chart, error, retry }: MermaidErrorComponentProps) {
  const t = useT();
  return (
    <div className="markdown-mermaid-error" role="alert">
      <div className="flex min-w-0 items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0">
          <p className="font-medium">{t("markdownMermaidFailed")}</p>
          <p className="mt-1 break-words font-mono text-xs opacity-80">{error}</p>
        </div>
      </div>
      <button
        type="button"
        className="markdown-mermaid-error-retry"
        onClick={retry}
        title={t("markdownRetryDiagram")}
        aria-label={t("markdownRetryDiagram")}
      >
        <RotateCw className="size-3.5" aria-hidden="true" />
      </button>
      <details className="mt-2 min-w-0">
        <summary className="cursor-pointer text-xs opacity-80">{t("markdownShowSource")}</summary>
        <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-black/10 p-2 text-xs">
          {chart}
        </pre>
      </details>
    </div>
  );
}

function codeText(child: ReactElement<CodeChildProps>): string {
  const raw = child.props.children;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw.filter((item): item is string => typeof item === "string").join("");
  }
  return "";
}

function CollapsibleCodeBlock({ children }: MarkdownPreProps) {
  const t = useT();
  const child = isValidElement<CodeChildProps>(children) ? children : null;
  const content = child ? codeText(child) : "";
  const lineCount = codeLineCount(content);
  const collapsible = lineCount > CODE_COLLAPSE_THRESHOLD;
  const contentId = useId();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const [copyTarget, setCopyTarget] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    setCopyTarget(
      shellRef.current?.querySelector<HTMLElement>('[data-streamdown="code-block"]') ?? null,
    );
  }, [content]);

  if (!child) return children;
  const codeBlock = cloneElement(child, { "data-block": "true" });
  const childProps = child.props as CodeChildProps & { "data-streamdown"?: string };
  const childClassName = childProps.className ?? "";
  if (childProps["data-streamdown"] === "mermaid-block") return children;
  if (/\b(?:katex|math-(?:inline|display))\b/.test(childClassName)) return children;
  if (/\blanguage-mermaid\b/.test(childClassName)) return codeBlock;

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard access can be unavailable in browser previews.
    }
  }

  const copyButton = (
    <button
      type="button"
      onClick={() => void copyCode()}
      className="markdown-code-copy-button absolute right-4 z-10 flex size-7 cursor-pointer items-center justify-center rounded-md bg-surface/90 text-muted hover:bg-surface-overlay hover:text-foreground"
      title={copied ? t("markdownCopied") : t("markdownCopyCode")}
      aria-label={copied ? t("markdownCopied") : t("markdownCopyCode")}
      data-copied={copied || undefined}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );

  return (
    <div ref={shellRef} className="markdown-code-shell w-full">
      <div
        id={contentId}
        className="markdown-code-content whitespace-pre"
        data-collapsed={collapsible ? !expanded : undefined}
      >
        {codeBlock}
      </div>
      {copyTarget ? createPortal(copyButton, copyTarget) : null}
      {collapsible && (
        <button
          type="button"
          className="mx-auto mt-1 flex h-7 items-center gap-1 rounded-md px-2 text-[11px] text-muted hover:bg-surface-overlay hover:text-foreground"
          onClick={() => setExpanded((current) => !current)}
          aria-controls={contentId}
          aria-expanded={expanded}
        >
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          {expanded ? t("markdownCollapseCode") : t("markdownExpandLines", { count: lineCount })}
        </button>
      )}
    </div>
  );
}

const markdownComponents: Components = {
  img: ImageFallback,
  pre: CollapsibleCodeBlock,
};

export const MarkdownMessage = memo(function MarkdownMessage({
  content,
  mode = "static",
  showCaret = false,
  className = "",
}: MarkdownMessageProps) {
  const t = useT();
  const reactMessageId = useId();
  const footnotePrefix = useMemo(
    () => `pideck-md-${reactMessageId.replace(/[^A-Za-z0-9_-]/g, "") || "message"}-`,
    [reactMessageId],
  );
  const remarkRehypeOptions = useMemo(() => ({ clobberPrefix: footnotePrefix }), [footnotePrefix]);
  const messageRehypePlugins = useMemo<RehypePlugin[]>(
    () => [...rehypePlugins, createFootnoteIdPlugin(footnotePrefix)],
    [footnotePrefix],
  );
  const components = useMemo<Components>(
    () => ({
      ...markdownComponents,
      a: (props) => safeLink(props, footnotePrefix, t),
    }),
    [footnotePrefix, t],
  );
  const urlTransform = useCallback(
    (url: string, key: string, node: unknown) => {
      if (key === "src") return null;
      if (isGeneratedFootnoteLink(node) && isSafeFootnoteFragment(url, footnotePrefix)) return url;
      return isSafeExternalUrl(url) ? url : null;
    },
    [footnotePrefix],
  );
  const openMermaidLink = useCallback(
    (target: EventTarget | null, activation: ChatLinkActivation = {}) => {
      if (!(target instanceof Element)) return false;
      const anchor = target.closest<Element>("[data-pideck-mermaid-href]");
      if (!anchor || !anchor.closest('[data-streamdown="mermaid"]')) return false;
      const href = anchor.getAttribute("data-pideck-mermaid-href");
      if (!href || !isSafeExternalUrl(href)) return true;
      openChatLink(href, activation);
      return true;
    },
    [],
  );
  const normalized = useMemo(() => deferIncompleteMermaid(sanitizeAgentText(content)), [content]);
  const mermaidKey = useMemo(() => `mermaid-${mermaidFenceSignature(normalized)}`, [normalized]);

  return (
    <div
      className="min-w-0 max-w-full"
      onClickCapture={(event) => {
        if (!openMermaidLink(event.target, event)) return;
        event.preventDefault();
        event.stopPropagation();
      }}
      onAuxClickCapture={(event) => {
        if (event.button !== 1 || !openMermaidLink(event.target, event)) return;
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDownCapture={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        if (!openMermaidLink(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <MarkdownRenderBoundary
        key={mermaidKey}
        fallback={
          <div className={`chat-markdown whitespace-pre-wrap break-words ${className}`}>
            {normalized}
          </div>
        }
      >
        <Streamdown
          className={`chat-markdown ${showCaret ? "chat-markdown-caret" : ""} ${className}`}
          plugins={markdownPlugins}
          remarkPlugins={remarkPlugins}
          remarkRehypeOptions={remarkRehypeOptions}
          rehypePlugins={messageRehypePlugins}
          components={components}
          mode={mode}
          dir="auto"
          parseIncompleteMarkdown
          normalizeHtmlIndentation
          skipHtml
          animated={
            mode === "streaming"
              ? { animation: "fadeIn", duration: 110, easing: "ease-out", sep: "word", stagger: 3 }
              : false
          }
          isAnimating={showCaret}
          caret={mode === "streaming" ? "block" : undefined}
          shikiTheme={["github-light", "github-dark"]}
          mermaid={{ config: mermaidConfig, errorComponent: MermaidError }}
          controls={{
            code: false,
            table: false,
            mermaid: {
              copy: true,
              download: false,
              fullscreen: true,
              panZoom: true,
            },
          }}
          lineNumbers={false}
          urlTransform={urlTransform}
        >
          {normalized}
        </Streamdown>
      </MarkdownRenderBoundary>
    </div>
  );
});
