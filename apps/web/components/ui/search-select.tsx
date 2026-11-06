"use client";

import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
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
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const container = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();

  const selected = options.find((option) => option.value === value);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) =>
      `${option.label ?? option.value} ${option.hint ?? ""}`.toLowerCase().includes(needle),
    );
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHighlight(
      Math.max(
        0,
        options.findIndex((option) => option.value === value),
      ),
    );
    const frame = requestAnimationFrame(() => input.current?.focus());
    const close = (event: MouseEvent) => {
      if (container.current && !container.current.contains(event.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("mousedown", close);
    };
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
    <div ref={container} className="relative min-w-0">
      <button
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
        <span className={cn("truncate", !selected && "text-muted-foreground")}>
          {selected ? (selected.label ?? selected.value) : placeholder}
        </span>
        <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
      </button>
      {open ? (
        <div
          className={cn(
            "absolute z-50 mt-1 w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg shadow-black/10",
            align === "end" ? "right-0" : "left-0",
          )}
        >
          <div className="flex items-center gap-2 border-b border-border px-2 pb-1.5 pt-1">
            <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              ref={input}
              role="combobox"
              aria-controls={listId}
              aria-expanded={open}
              aria-autocomplete="list"
              value={query}
              placeholder={searchPlaceholder}
              onChange={(event) => {
                setQuery(event.target.value);
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
              className="h-7 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {filtered.length}
            </span>
          </div>
          <div id={listId} ref={list} className="max-h-72 overflow-y-auto py-1">
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
                  <span className="min-w-0 flex-1 truncate">
                    {option.label ?? option.value}
                  </span>
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
        </div>
      ) : null}
    </div>
  );
}
