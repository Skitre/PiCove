import type { ReactNode } from "react";

export function FileToolButton({
  label,
  children,
  onClick,
  disabled = false,
  pressed,
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className="flex size-7 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground focus-visible:outline focus-visible:outline-focus disabled:opacity-35"
    >
      {children}
    </button>
  );
}
