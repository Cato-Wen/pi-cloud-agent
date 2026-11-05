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
      onNotice("Personal token saved.", "success");
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
      onNotice("Personal token removed.", "success");
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
          <h3 className="text-sm font-medium">Personal access token</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Lets tasks clone, commit, push and open pull requests <strong>as you</strong>.
            Stored encrypted on the server and never shown again.
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
                Replace
              </Button>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => setConfirmingRemove(true)}
              >
                Remove
              </Button>
            </div>
          ) : null}

          {showForm ? <CreationGuide /> : null}
        </div>
      </div>
      <ConfirmDialog
        open={confirmingRemove}
        title="Remove your personal token?"
        description="Tasks on repositories that only this token can reach will stop until you add another one."
        confirmLabel="Remove"
        busyLabel="Removing…"
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
        placeholder="ghp_… or github_pat_…"
        aria-label="GitHub personal access token"
        className="h-9 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 font-mono text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      />
      <Button type="submit" size="sm" disabled={busy || draft.trim().length < 20}>
        {busy ? "Checking…" : "Save"}
      </Button>
      {cancellable ? (
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
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
  if (status.state === "invalid") return { text: "Invalid or expired", tone: "err" };
  if (status.pendingHint) return { text: "Waiting for approval", tone: "warn" };
  if (expiry.soon) return { text: `Expires ${expiry.label}`, tone: "warn" };
  return { text: "Valid", tone: "ok" };
}

function summaryLine(status: PersonalTokenStatus, expiryLabel: string): string {
  const parts = [status.kind ?? "token", `…${status.last4}`];
  if (status.login) parts.push(status.login);
  if (status.scopes.length > 0) parts.push(`scopes ${status.scopes.join(", ")}`);
  parts.push(status.expiresAt ? `expires ${expiryLabel}` : "no expiry");
  return parts.join(" · ");
}

function StatusDetail({ status }: { status: PersonalTokenStatus }) {
  if (status.state === "invalid") {
    return (
      <p
        role="alert"
        className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 leading-5 text-red-700 dark:text-red-300"
      >
        GitHub rejected this token. Tasks on repositories that need it will fail until you
        replace it.
      </p>
    );
  }
  if (status.pendingHint) {
    return (
      <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 leading-5 text-amber-800 dark:text-amber-300">
        The token is valid but cannot see any private repository yet. Fine-grained tokens for an
        organization need an owner&apos;s approval. You can wait, or replace it with a classic
        token (<code>repo</code> + <code>workflow</code>) to start now.
      </p>
    );
  }
  const shown = status.writableRepos.slice(0, 3).join(", ");
  const more = status.writableRepos.length - 3;
  return (
    <p className="text-muted-foreground">
      Can write:{" "}
      {status.writableRepos.length === 0
        ? "no repositories"
        : more > 0
          ? `${shown} and ${more} more`
          : shown}
    </p>
  );
}

function CreationGuide() {
  return (
    <details className="mt-3 text-xs text-muted-foreground">
      <summary className="cursor-pointer text-foreground">How to create a token</summary>
      <ol className="mt-2 list-decimal space-y-1.5 pl-4 leading-5">
        <li>
          <strong>Classic (recommended, works immediately):</strong> GitHub → Settings →
          Developer settings → Tokens (classic) → Generate new token. Check <code>repo</code>{" "}
          and <code>workflow</code>, nothing else.
        </li>
        <li>
          <strong>Fine-grained (narrower, needs organization approval):</strong> choose your
          organization as resource owner, select only the repositories you work on, and grant
          Contents and Pull requests read &amp; write.
        </li>
        <li>
          If the token shows <strong>Configure SSO</strong>, authorize your organization before
          saving it here.
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
