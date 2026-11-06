const DAY_MS = 86_400_000;

export interface Expiry {
  /** Human date, or "永不过期". */
  label: string;
  /** Within the warning window — time to replace the token. */
  soon: boolean;
  expired: boolean;
}

/** How a token's expiry should be presented, with a warning window in days. */
export function describeExpiry(expiresAt: string | null, warningDays = 14): Expiry {
  if (!expiresAt) return { label: "永不过期", soon: false, expired: false };
  const date = new Date(expiresAt);
  const days = Math.ceil((date.getTime() - Date.now()) / DAY_MS);
  return {
    label: date.toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "short",
      day: "numeric",
    }),
    soon: days <= warningDays,
    expired: days <= 0,
  };
}
