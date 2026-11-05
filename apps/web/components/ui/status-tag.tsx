export type StatusTone = "ok" | "warn" | "err" | "muted";

const TONES: Record<StatusTone, string> = {
  ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  err: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  muted: "border-border bg-muted text-muted-foreground",
};

/** A small pill naming a state: valid, expiring, invalid, read-only. */
export function StatusTag({ tone, children }: { tone: StatusTone; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}
