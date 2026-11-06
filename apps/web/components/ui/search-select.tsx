"use client";

import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { FloatingPanel, useFloatingPanel } from "@/components/ui/floating-panel";
import { cn } from "@/lib/utils";

export interface SearchSelectOption {
  value: string;
  label?: string;
  hint?: string;
}

/**
 * A select for long lists: type to filter, arrow keys to move, Enter to pick.
 * Built on plain elements so it needs no extra dependency.
 */
export function SearchSelect({
  options,
  value,
  onChange,
  placeholder = "选择…",
  searchPlaceholder = "搜索…",
  emptyText = "没有匹配项",
  ariaLabel,
  disabled = false,
  className,
  align = "start",
  allowCustom = false,
}: {
  options: SearchSelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
  align?: "start" | "end";
  /** Offer what was typed as a choice when the list does not contain it (lists are capped). */
  allowCustom?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const close = useCallback(() => setOpen(false), []);
  const position = useFloatingPanel({ open, align, trigger, panel, input, onClose: close });

  const selected = options.find((option) => option.value === value);
  const filtered = useMemo(() => {
    const typed = query.trim();
    const needle = typed.toLowerCase();
    const matches = needle
      ? options.filter((option) =>
          `${option.label ?? option.value} ${option.hint ?? ""}`.toLowerCase().includes(needle),
        )
      : options;
    const exact = options.some((option) => option.value.toLowerCase() === needle);
    if (!allowCustom || !typed || exact) return matches;
    return [...matches, { value: typed, label: `使用「${typed}」`, hint: "不在列表中" }];
  }, [options, query, allowCustom]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHighlight(
      Math.max(
        0,
        options.findIndex((option) => option.value === value),
      ),
    );
  }, [open, options, value]);

  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${highlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  const pick = (option: SearchSelectOption | undefined) => {
    if (!option) return;
    onChange(option.value);
    setOpen(false);
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          "flex h-7 min-w-0 items-center gap-1 rounded-md px-1.5 text-xs outline-none hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
      >
        <span className={cn("truncate", !selected && !value && "text-muted-foreground")}>
          {selected ? (selected.label ?? selected.value) : value || placeholder}
        </span>
        <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
      </button>
      <FloatingPanel
        position={position}
        panelRef={panel}
        inputRef={input}
        listId={listId}
        query={query}
        onQueryChange={(next) => {
          setQuery(next);
          setHighlight(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setHighlight((index) => Math.min(index + 1, filtered.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setHighlight((index) => Math.max(index - 1, 0));
          } else if (event.key === "Enter") {
            event.preventDefault();
            pick(filtered[highlight]);
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
        searchPlaceholder={searchPlaceholder}
        count={filtered.length}
      >
        <div ref={list}>
          {filtered.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">{emptyText}</p>
          ) : (
            filtered.map((option, index) => (
              <button
                type="button"
                key={option.value}
                aria-pressed={option.value === value}
                data-index={index}
                tabIndex={-1}
                onMouseEnter={() => setHighlight(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(option)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs",
                  index === highlight && "bg-accent",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{option.label ?? option.value}</span>
                {option.hint ? (
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {option.hint}
                  </span>
                ) : null}
                {option.value === value ? <CheckIcon className="size-3.5 shrink-0" /> : null}
              </button>
            ))
          )}
        </div>
      </FloatingPanel>
    </>
  );
}
