"use client";

import type { PlatformCredentialSummary } from "@pi-cloud-agent/protocol";
import { KeyRoundIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { api } from "@/lib/api";

const EXPIRY_WARNING_DAYS = 14;

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
              <Tag tone="err">Expired</Tag>
            ) : expiry.soon ? (
              <Tag tone="warn">Expires {expiry.label}</Tag>
            ) : (
              <Tag tone="ok">Valid</Tag>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {credential.accountLogin} · <code className="font-mono">…{credential.last4}</code> ·{" "}
            {credential.expiresAt ? `expires ${expiry.label}` : "no expiry"}
            {credential.probedAt ? ` · probed ${relative(credential.probedAt)}` : ""}
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
            {busy === "probe" ? "Probing…" : "Re-probe"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => setReplacing((value) => !value)}
          >
            Replace
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={busy !== null}
            onClick={() => setConfirmingRemove(true)}
          >
            Remove
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
              onNotice("Token replaced and probed.", "success");
            });
          }}
        >
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="New token for this credential"
            aria-label="Replacement token"
            className="h-9 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 font-mono text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          />
          <Button type="submit" size="sm" disabled={busy !== null || token.trim().length < 20}>
            {busy === "replace" ? "Probing…" : "Save & probe"}
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
            <th className="py-1.5 pr-3 font-medium">Repository</th>
            <th className="w-24 py-1.5 font-medium">Access</th>
          </tr>
        </thead>
        <tbody>
          {credential.repoAccess.length === 0 ? (
            <tr>
              <td colSpan={2} className="py-3 text-muted-foreground">
                This token reaches no private repository.
              </td>
            </tr>
          ) : (
            credential.repoAccess.map((entry) => (
              <tr key={entry.repo} className="border-b border-border/60 last:border-0">
                <td className="py-1.5 pr-3 font-mono">{entry.repo}</td>
                <td className="py-1.5">
                  {entry.access === "write" ? (
                    <Tag tone="ok">write</Tag>
                  ) : (
                    <Tag tone="muted">read-only</Tag>
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <ConfirmDialog
        open={confirmingRemove}
        title={`Remove “${credential.label}”?`}
        description="Agents that rely on this token for read access will fail until another credential reaches their repositories."
        confirmLabel="Remove"
        busyLabel="Removing…"
        busy={busy === "remove"}
        onCancel={() => setConfirmingRemove(false)}
        onConfirm={() =>
          void run("remove", async () => {
            await api.deletePlatformCredential(credential.id);
            setConfirmingRemove(false);
            onNotice("Credential removed.", "success");
          })
        }
      />
    </section>
  );
}

function Tag({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "err" | "muted";
  children: React.ReactNode;
}) {
  const classes = {
    ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    warn: "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300",
    err: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
    muted: "border-border bg-muted text-muted-foreground",
  }[tone];
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${classes}`}
    >
      {children}
    </span>
  );
}

function describeExpiry(expiresAt: string | null): {
  label: string;
  soon: boolean;
  expired: boolean;
} {
  if (!expiresAt) return { label: "never", soon: false, expired: false };
  const date = new Date(expiresAt);
  const days = Math.ceil((date.getTime() - Date.now()) / 86_400_000);
  return {
    label: date.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    }),
    soon: days <= EXPIRY_WARNING_DAYS,
    expired: days <= 0,
  };
}

function relative(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}
