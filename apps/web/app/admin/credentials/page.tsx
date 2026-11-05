"use client";

import type { PlatformCredentialSummary } from "@pi-cloud-agent/protocol";
import { PlusIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { PlatformCredentialCard } from "@/components/PlatformCredentialCard";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

type NoticeKind = "success" | "error";
type Notice = { message: string; kind: NoticeKind } | null;

/**
 * Operator-only: tokens the platform uses on behalf of built-in agents, one per
 * organization without a GitHub App installation. Saving a token probes it per
 * private repository; the table is what git allowed, not what was pasted.
 */
export default function PlatformCredentialsPage() {
  const [isOperator, setIsOperator] = useState<boolean | null>(null);
  const [credentials, setCredentials] = useState<PlatformCredentialSummary[]>([]);
  const [adding, setAdding] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  const notify = useCallback((message: string, kind: NoticeKind) => {
    setNotice({ message, kind });
  }, []);

  const refresh = useCallback(async () => {
    setCredentials(await api.listPlatformCredentials());
  }, []);

  useEffect(() => {
    let alive = true;
    void api
      .getCurrentUser()
      .then(async (me) => {
        if (!alive) return;
        setIsOperator(Boolean(me.isOperator));
        if (me.isOperator) await refresh();
      })
      .catch((cause) => {
        if (alive) setLoadError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      alive = false;
    };
  }, [refresh]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  return (
    <div className="h-full overflow-y-auto bg-background">
      <header className="sticky top-0 z-10 flex h-12 items-center gap-2 border-b border-border bg-background px-5 text-[13px]">
        <span className="text-muted-foreground">Admin /</span>
        <h1 className="font-medium">Credentials</h1>
      </header>
      <main className="mx-auto max-w-4xl px-5 py-8 sm:px-8">
        {isOperator === false ? <OperatorRequired /> : null}
        {isOperator ? (
          <>
            <PageIntro onAdd={() => setAdding((value) => !value)} />
            {adding ? (
              <AddCredentialForm
                onCancel={() => setAdding(false)}
                onSaved={async () => {
                  setAdding(false);
                  await refresh();
                  notify("Token saved and probed.", "success");
                }}
              />
            ) : null}
            <div className="space-y-3">
              {credentials.map((credential) => (
                <PlatformCredentialCard
                  key={credential.id}
                  credential={credential}
                  onChanged={refresh}
                  onNotice={notify}
                />
              ))}
              {credentials.length === 0 && !adding ? <EmptyState /> : null}
            </div>
          </>
        ) : null}
        {loadError ? (
          <p role="alert" className="mt-4 text-sm text-destructive">
            {loadError}
          </p>
        ) : null}
      </main>
      {notice ? <NoticeToast notice={notice} /> : null}
    </div>
  );
}

function PageIntro({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="mb-6 flex items-start gap-4">
      <div className="min-w-0 flex-1">
        <h2 className="text-xl font-medium tracking-[-0.02em]">Platform credentials</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          One token per organization that has no GitHub App installation. The platform uses it
          to read code on behalf of agents; saving probes every private repository the token can
          see and records whether git allows read or write. Organizations with the App installed
          need no token here — users write with their own sign-in.
        </p>
      </div>
      <Button type="button" size="sm" onClick={onAdd}>
        <PlusIcon className="size-3.5" />
        Add token
      </Button>
    </div>
  );
}

function AddCredentialForm({
  onCancel,
  onSaved,
}: {
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.createPlatformCredential({ label: label.trim(), token: token.trim() });
      await onSaved();
    } catch (cause) {
      setError(
        (cause instanceof Error ? cause.message : String(cause)).replace(/^\d{3}:\s*/, ""),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="mb-6 rounded-xl border border-foreground/60 bg-card px-4 py-4"
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <label className="block text-xs text-muted-foreground" htmlFor="credential-label">
        Label
      </label>
      <input
        id="credential-label"
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        placeholder="e.g. food-truck read-only"
        className="mt-1 h-9 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      />
      <label className="mt-3 block text-xs text-muted-foreground" htmlFor="credential-token">
        Token
      </label>
      <input
        id="credential-token"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={token}
        onChange={(event) => setToken(event.target.value)}
        placeholder="github_pat_… / ghp_…"
        className="mt-1 h-9 w-full rounded-lg border border-input bg-background px-3 font-mono text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      />
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="mt-3 flex gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={busy || label.trim().length === 0 || token.trim().length < 20}
        >
          {busy ? "Probing…" : "Save & probe"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function OperatorRequired() {
  return (
    <p className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
      Operator access required. Operators are listed in <code>OPERATOR_GITHUB_LOGINS</code>.
    </p>
  );
}

function EmptyState() {
  return (
    <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
      No platform credentials yet. Add a read-only token for each organization the App is not
      installed on.
    </p>
  );
}

function NoticeToast({ notice }: { notice: NonNullable<Notice> }) {
  return (
    <div className="pointer-events-none fixed right-4 top-4 z-50 w-[min(24rem,calc(100vw-2rem))]">
      <p
        role={notice.kind === "success" ? "status" : "alert"}
        className={`pointer-events-auto rounded-xl border px-4 py-3 text-sm shadow-lg shadow-black/10 ${
          notice.kind === "success"
            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
            : "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
        }`}
      >
        {notice.message}
      </p>
    </div>
  );
}
