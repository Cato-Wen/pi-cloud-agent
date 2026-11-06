"use client";

import type { PersonalTokenStatus } from "@pi-cloud-agent/protocol";
import { KeyRoundIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { StatusTag, type StatusTone } from "@/components/ui/status-tag";
import { api, invalidateRepositoryCache } from "@/lib/api";
import { describeExpiry } from "@/lib/expiry";

/** Fired after a personal token is saved or removed, so pickers and onboarding refresh. */
export const PERSONAL_TOKEN_CHANGED = "personal-token-changed";

type Notify = (message: string, kind: "success" | "error") => void;

/**
 * A developer's own GitHub token: the credential that lets tasks commit, push
 * and open pull requests as them. The card shows what the server learned about
 * the token — never the token itself.
 */
export function PersonalTokenCard({ onNotice }: { onNotice: Notify }) {
  const [status, setStatus] = useState<PersonalTokenStatus | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.getPersonalToken());
    } catch (cause) {
      setError(detail(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const announceChange = () => {
    invalidateRepositoryCache();
    window.dispatchEvent(new Event(PERSONAL_TOKEN_CHANGED));
  };

  const save = async () => {
    const token = draft.trim();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.savePersonalToken(token));
      setDraft("");
      setReplacing(false);
      announceChange();
      onNotice("个人 token 已保存。", "success");
    } catch (cause) {
      setError(detail(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.deletePersonalToken();
      setStatus(await api.getPersonalToken());
      announceChange();
      onNotice("个人 token 已删除。", "success");
    } catch (cause) {
      onNotice(detail(cause), "error");
    } finally {
      setBusy(false);
      setConfirmingRemove(false);
    }
  };

  const showForm = !status?.connected || replacing || status.state === "invalid";

  return (
    <section className="rounded-xl border border-border bg-card px-4 py-4">
      <div className="flex items-start gap-4">
        <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted">
          <KeyRoundIcon className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">个人访问 token（PAT）</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            让任务以<strong>你的身份</strong>克隆、提交、推送和创建 pull request。token
            在服务器上加密存储，之后不再显示。
          </p>

          {status?.connected ? <TokenStatus status={status} /> : null}

          {showForm ? (
            <TokenForm
              draft={draft}
              busy={busy}
              cancellable={replacing}
              onChange={setDraft}
              onSubmit={save}
              onCancel={() => setReplacing(false)}
            />
          ) : null}

          {error ? (
            <p role="alert" className="mt-2 text-xs leading-5 text-destructive">
              {error}
            </p>
          ) : null}

          {status?.connected && !showForm ? (
            <div className="mt-3 flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setReplacing(true)}
              >
                更换
              </Button>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => setConfirmingRemove(true)}
              >
                删除
              </Button>
            </div>
          ) : null}

          {showForm ? <CreationGuide /> : null}
        </div>
      </div>
      <ConfirmDialog
        open={confirmingRemove}
        title="删除你的个人 token？"
        description="只有此 token 才能访问的仓库上的任务将会停止，直到你添加新的 token。"
        confirmLabel="删除"
        busyLabel="删除中…"
        busy={busy}
        onCancel={() => setConfirmingRemove(false)}
        onConfirm={() => void remove()}
      />
    </section>
  );
}

function TokenForm({
  draft,
  busy,
  cancellable,
  onChange,
  onSubmit,
  onCancel,
}: {
  draft: string;
  busy: boolean;
  cancellable: boolean;
  onChange: (value: string) => void;
  onSubmit: () => Promise<void>;
  onCancel: () => void;
}) {
  return (
    <form
      className="mt-3 flex gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit();
      }}
    >
      <input
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={draft}
        onChange={(event) => onChange(event.target.value)}
        placeholder="ghp_… 或 github_pat_…"
        aria-label="GitHub 个人访问 token"
        className="h-9 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 font-mono text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      />
      <Button type="submit" size="sm" disabled={busy || draft.trim().length < 20}>
        {busy ? "检查中…" : "保存"}
      </Button>
      {cancellable ? (
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          取消
        </Button>
      ) : null}
    </form>
  );
}

function TokenStatus({ status }: { status: PersonalTokenStatus }) {
  const expiry = describeExpiry(status.expiresAt);
  const badge = statusBadge(status, expiry);
  return (
    <div className="mt-3 space-y-2 text-xs">
      <p className="flex flex-wrap items-center gap-2 text-muted-foreground">
        <StatusTag tone={badge.tone}>{badge.text}</StatusTag>
        <span>{summaryLine(status, expiry.label)}</span>
      </p>
      <StatusDetail status={status} />
    </div>
  );
}

function statusBadge(
  status: PersonalTokenStatus,
  expiry: { label: string; soon: boolean },
): { text: string; tone: StatusTone } {
  if (status.state === "invalid") return { text: "已失效或过期", tone: "err" };
  if (status.pendingHint) return { text: "等待组织审批", tone: "warn" };
  if (expiry.soon) return { text: `${expiry.label} 到期`, tone: "warn" };
  return { text: "有效", tone: "ok" };
}

function summaryLine(status: PersonalTokenStatus, expiryLabel: string): string {
  const parts = [status.kind ?? "token", `…${status.last4}`];
  if (status.login) parts.push(status.login);
  if (status.scopes.length > 0) parts.push(`scope：${status.scopes.join(", ")}`);
  parts.push(status.expiresAt ? `${expiryLabel} 到期` : "不过期");
  return parts.join(" · ");
}

function StatusDetail({ status }: { status: PersonalTokenStatus }) {
  if (status.state === "invalid") {
    return (
      <p
        role="alert"
        className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 leading-5 text-red-700 dark:text-red-300"
      >
        GitHub 已拒绝此 token。需要它的仓库上的任务将会失败，直到你更换 token。
      </p>
    );
  }
  if (status.pendingHint) {
    return (
      <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 leading-5 text-amber-800 dark:text-amber-300">
        此 token 有效，但目前还看不到任何私有仓库。组织的 fine-grained token 需要组织 owner
        审批。你可以等待，也可以换成带 <code>repo</code> + <code>workflow</code> 的 classic
        token，立即开始。
      </p>
    );
  }
  const shown = status.writableRepos.slice(0, 3).join(", ");
  const more = status.writableRepos.length - 3;
  return (
    <p className="text-muted-foreground">
      可写仓库：
      {status.writableRepos.length === 0
        ? "无"
        : more > 0
          ? `${shown} 及另外 ${more} 个`
          : shown}
    </p>
  );
}

function CreationGuide() {
  return (
    <details className="mt-3 text-xs text-muted-foreground">
      <summary className="cursor-pointer text-foreground">如何创建 token</summary>
      <ol className="mt-2 list-decimal space-y-1.5 pl-4 leading-5">
        <li>
          <strong>Classic（推荐，立即可用）：</strong>GitHub → Settings → Developer settings →
          Tokens (classic) → Generate new token。只勾选 <code>repo</code> 和{" "}
          <code>workflow</code>，其他都不要勾。
        </li>
        <li>
          <strong>Fine-grained（范围更小，需要组织审批）：</strong>选择你的组织作为 resource
          owner，只选择你参与的仓库，并授予 Contents 和 Pull requests 的 read &amp; write 权限。
        </li>
        <li>
          如果 token 显示 <strong>Configure SSO</strong>，请先为你的组织授权，再在这里保存。
        </li>
      </ol>
    </details>
  );
}

function detail(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  // request() prefixes the HTTP status; the server's sentence is what helps.
  return message.replace(/^\d{3}:\s*/, "");
}
