"use client";

import type { PlatformCredentialSummary } from "@pi-cloud-agent/protocol";
import { KeyRoundIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { StatusTag } from "@/components/ui/status-tag";
import { api } from "@/lib/api";
import { describeExpiry } from "@/lib/expiry";

type Notify = (message: string, kind: "success" | "error") => void;

/** One operator-managed token and what git let it do, repository by repository. */
export function PlatformCredentialCard({
  credential,
  onChanged,
  onNotice,
}: {
  credential: PlatformCredentialSummary;
  onChanged: () => Promise<void>;
  onNotice: Notify;
}) {
  const [busy, setBusy] = useState<"probe" | "replace" | "remove" | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [token, setToken] = useState("");
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (kind: "probe" | "replace" | "remove", work: () => Promise<unknown>) => {
    setBusy(kind);
    setError(null);
    try {
      await work();
      await onChanged();
    } catch (cause) {
      const message = (cause instanceof Error ? cause.message : String(cause)).replace(
        /^\d{3}:\s*/,
        "",
      );
      setError(message);
      onNotice(message, "error");
    } finally {
      setBusy(null);
    }
  };

  const expiry = describeExpiry(credential.expiresAt);

  return (
    <section className="rounded-xl border border-border bg-card px-4 py-4">
      <div className="flex items-start gap-4">
        <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted">
          <KeyRoundIcon className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">{credential.label}</h3>
            {expiry.expired ? (
              <StatusTag tone="err">已过期</StatusTag>
            ) : expiry.soon ? (
              <StatusTag tone="warn">{expiry.label} 到期</StatusTag>
            ) : (
              <StatusTag tone="ok">有效</StatusTag>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {credential.accountLogin} · <code className="font-mono">…{credential.last4}</code> ·{" "}
            {credential.expiresAt ? `${expiry.label} 到期` : "不过期"}
            {credential.probedAt ? ` · ${relative(credential.probedAt)}探测` : ""}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void run("probe", () => api.probePlatformCredential(credential.id))}
          >
            <RefreshCwIcon className="size-3.5" />
            {busy === "probe" ? "探测中…" : "重新探测"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => setReplacing((value) => !value)}
          >
            更换
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={busy !== null}
            onClick={() => setConfirmingRemove(true)}
          >
            删除
          </Button>
        </div>
      </div>

      {replacing ? (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void run("replace", async () => {
              await api.updatePlatformCredential(credential.id, { token: token.trim() });
              setToken("");
              setReplacing(false);
              onNotice("token 已更换并探测。", "success");
            });
          }}
        >
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="此凭证的新 token"
            aria-label="替换用的 token"
            className="h-9 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 font-mono text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          />
          <Button type="submit" size="sm" disabled={busy !== null || token.trim().length < 20}>
            {busy === "replace" ? "探测中…" : "保存并探测"}
          </Button>
        </form>
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <table className="mt-4 w-full text-xs">
        <thead>
          <tr className="border-b border-border text-left text-muted-foreground">
            <th className="py-1.5 pr-3 font-medium">仓库</th>
            <th className="w-24 py-1.5 font-medium">权限</th>
          </tr>
        </thead>
        <tbody>
          {credential.repoAccess.length === 0 ? (
            <tr>
              <td colSpan={2} className="py-3 text-muted-foreground">
                此 token 无法访问任何私有仓库。
              </td>
            </tr>
          ) : (
            credential.repoAccess.map((entry) => (
              <tr key={entry.repo} className="border-b border-border/60 last:border-0">
                <td className="py-1.5 pr-3 font-mono">{entry.repo}</td>
                <td className="py-1.5">
                  {entry.access === "write" ? (
                    <StatusTag tone="ok">可写</StatusTag>
                  ) : (
                    <StatusTag tone="muted">只读</StatusTag>
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <ConfirmDialog
        open={confirmingRemove}
        title={`删除「${credential.label}」？`}
        description="依赖此 token 进行只读访问的 agent 将会失败，直到有其他凭证能访问它们的仓库。"
        confirmLabel="删除"
        busyLabel="删除中…"
        busy={busy === "remove"}
        onCancel={() => setConfirmingRemove(false)}
        onConfirm={() =>
          void run("remove", async () => {
            await api.deletePlatformCredential(credential.id);
            setConfirmingRemove(false);
            onNotice("凭证已删除。", "success");
          })
        }
      />
    </section>
  );
}

function relative(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}
