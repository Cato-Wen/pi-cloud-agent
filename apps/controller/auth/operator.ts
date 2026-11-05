import type { Context, Next } from "hono";
import type { Config } from "../config";
import type { AppEnv } from "../http/deps";

/**
 * Operators are named by GitHub login in `OPERATOR_GITHUB_LOGINS`. They manage
 * the plugin catalog, platform credentials, built-in agents, and platform
 * skills. Everything else is per-user.
 */
export function isOperator(config: Config, login: string | undefined): boolean {
  if (!login) return false;
  return config.auth.operatorLogins.includes(login.toLowerCase());
}

export async function requireOperator(c: Context<AppEnv>, next: Next): Promise<void> {
  if (!isOperator(c.get("config"), c.get("user")?.login)) {
    c.res = c.json({ error: "operator access required" }, 403);
    return;
  }
  await next();
}
