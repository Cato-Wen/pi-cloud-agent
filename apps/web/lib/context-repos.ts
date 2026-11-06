const PREFIX = "pca-context-repos:";

/** The context repositories last used with this primary repository, if the browser kept them. */
export function loadContextRepos(primary: string): string[] {
  if (!primary) return [];
  try {
    const raw = localStorage.getItem(`${PREFIX}${primary.toLowerCase()}`);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export function saveContextRepos(primary: string, repos: string[]): void {
  if (!primary) return;
  try {
    const key = `${PREFIX}${primary.toLowerCase()}`;
    if (repos.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(repos));
  } catch {
    // Browser privacy settings may make localStorage unavailable.
  }
}
