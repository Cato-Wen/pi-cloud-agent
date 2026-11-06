"use client";

import type { ReposResponse } from "@pi-cloud-agent/protocol";
import { CheckSquareIcon, PaperclipIcon, SquareIcon } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { FloatingPanel, useFloatingPanel } from "@/components/ui/floating-panel";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type ContextRepo = ReposResponse["repos"][number];

/**
 * Pick the read-only repositories to clone next to the primary one.
 *
 * Candidates come from everything the user's credentials can read. Checked
 * repositories stay at the top so a long list never hides the choice; the
 * selection applies as soon as the panel closes.
 */
export function ContextRepoPicker({
  primary,
  value,
  onChange,
  disabled = false,
  className,
}: {
  primary: string;
  value: string[];
  onChange: (repos: string[]) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<ContextRepo[]>([]);
  const [loading, setLoading] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const close = useCallback(() => setOpen(false), []);
  const position = useFloatingPanel({
    open,
    align: "end",
    trigger,
    panel,
    input,
    onClose: close,
  });

  useEffect(() => {
    if (!open || !primary) return;
    let alive = true;
    setQuery("");
    setLoading(true);
    api
      .listContextRepos(primary)
      .then((repos) => {
        if (alive) setCandidates(repos);
      })
      .catch(() => {
        if (alive) setCandidates([]);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, primary]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const known = new Set(candidates.map((repo) => repo.fullName));
    // A repository chosen earlier that no credential can read any more still
    // shows, checked, so the user sees what the request will carry.
    const all = [
      ...value.filter((name) => !known.has(name)).map((name) => ({ fullName: name })),
      ...candidates,
    ];
    const selected = new Set(value);
    return all
      .filter((repo) => !needle || repo.fullName.toLowerCase().includes(needle))
      .sort((left, right) => {
        const pick = Number(selected.has(right.fullName)) - Number(selected.has(left.fullName));
        return pick || left.fullName.localeCompare(right.fullName);
      });
  }, [candidates, query, value]);

  const toggle = (fullName: string) => {
    onChange(
      value.includes(fullName)
        ? value.filter((name) => name !== fullName)
        : [...value, fullName],
    );
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label="上下文仓库"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled || !primary}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          "flex h-7 min-w-0 items-center gap-1 rounded-md px-1.5 text-xs outline-none hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50",
          value.length === 0 && "text-muted-foreground",
          className,
        )}
      >
        <PaperclipIcon className="size-3.5 shrink-0" />
        <span className="truncate">
          {value.length > 0 ? `上下文仓库 (${value.length})` : "上下文仓库"}
        </span>
      </button>
      <FloatingPanel
        position={position}
        panelRef={panel}
        inputRef={input}
        listId={listId}
        query={query}
        onQueryChange={setQuery}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
        searchPlaceholder="搜索可读仓库，例如 team-cookbook"
        count={loading ? "加载中…" : rows.length}
        footer={
          <p className="border-t border-border px-2 pt-1.5 pb-1 text-[10px] text-muted-foreground">
            上下文仓库会以只读方式克隆到主仓库旁边，agent 只能读取，不能提交。
          </p>
        }
      >
        {rows.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            {loading ? "正在读取你的凭证能看到的仓库…" : "没有匹配的仓库"}
          </p>
        ) : (
          rows.map((repo) => {
            const checked = value.includes(repo.fullName);
            return (
              <button
                type="button"
                key={repo.fullName}
                aria-pressed={checked}
                tabIndex={-1}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => toggle(repo.fullName)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent"
              >
                {checked ? (
                  <CheckSquareIcon className="size-3.5 shrink-0" />
                ) : (
                  <SquareIcon className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate">{repo.fullName}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">只读</span>
              </button>
            );
          })
        )}
      </FloatingPanel>
    </>
  );
}
