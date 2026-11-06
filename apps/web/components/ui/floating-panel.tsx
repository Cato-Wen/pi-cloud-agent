"use client";

import { SearchIcon } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";
import { createPortal } from "react-dom";

const PANEL_WIDTH = 448;
const PANEL_MAX_HEIGHT = 360;
const GAP = 4;

export interface PanelPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

/**
 * Where the panel goes so it stays on screen: below the trigger when there is
 * room, otherwise above; clamped to the viewport horizontally.
 */
export function positionPanel(trigger: HTMLElement, align: "start" | "end"): PanelPosition {
  const rect = trigger.getBoundingClientRect();
  const width = Math.min(PANEL_WIDTH, window.innerWidth - 16);
  const left = Math.max(
    8,
    Math.min(align === "end" ? rect.right - width : rect.left, window.innerWidth - width - 8),
  );
  const below = window.innerHeight - rect.bottom - GAP - 8;
  const above = rect.top - GAP - 8;
  if (below >= Math.min(PANEL_MAX_HEIGHT, above) || below >= 200) {
    return {
      top: rect.bottom + GAP,
      left,
      width,
      maxHeight: Math.min(PANEL_MAX_HEIGHT, below),
    };
  }
  const maxHeight = Math.min(PANEL_MAX_HEIGHT, above);
  return { top: rect.top - GAP - maxHeight, left, width, maxHeight };
}

/**
 * The behaviour every popover panel shares: it follows its trigger on scroll
 * and resize, focuses its input when it opens, and closes on an outside click.
 */
export function useFloatingPanel({
  open,
  align,
  trigger,
  panel,
  input,
  onClose,
}: {
  open: boolean;
  align: "start" | "end";
  trigger: RefObject<HTMLElement | null>;
  panel: RefObject<HTMLElement | null>;
  input: RefObject<HTMLInputElement | null>;
  onClose: () => void;
}): PanelPosition | null {
  const [position, setPosition] = useState<PanelPosition | null>(null);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => input.current?.focus());
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (trigger.current?.contains(target) || panel.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("mousedown", close);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("mousedown", close);
    };
  }, [open, trigger, panel, input, onClose]);

  // The panel is portaled to <body> so no ancestor can clip it; it follows the
  // trigger on scroll and resize.
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      if (trigger.current) setPosition(positionPanel(trigger.current, align));
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, align, trigger]);

  return open ? position : null;
}

/** The portaled panel chrome with a search box on top. */
export function FloatingPanel({
  position,
  panelRef,
  inputRef,
  listId,
  query,
  onQueryChange,
  onKeyDown,
  searchPlaceholder,
  count,
  children,
  footer,
}: {
  position: PanelPosition | null;
  panelRef: RefObject<HTMLDivElement | null>;
  inputRef: RefObject<HTMLInputElement | null>;
  listId: string;
  query: string;
  onQueryChange: (value: string) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  searchPlaceholder: string;
  count: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  if (!position || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={panelRef}
      style={{
        top: position.top,
        left: position.left,
        width: position.width,
        maxHeight: position.maxHeight,
      }}
      className="fixed z-[100] flex flex-col rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg shadow-black/10"
    >
      <div className="flex items-center gap-2 border-b border-border px-2 pb-1.5 pt-1">
        <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          role="combobox"
          aria-controls={listId}
          aria-expanded
          aria-autocomplete="list"
          value={query}
          placeholder={searchPlaceholder}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={onKeyDown}
          className="h-7 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
        />
        <span className="shrink-0 text-[10px] text-muted-foreground">{count}</span>
      </div>
      <div id={listId} className="min-h-0 flex-1 overflow-y-auto py-1">
        {children}
      </div>
      {footer}
    </div>,
    document.body,
  );
}
