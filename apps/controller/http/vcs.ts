import { type Context, Hono } from "hono";
import { z } from "zod";
import {
  beginVcsConnection,
  disconnectVcsConnection,
  finishVcsConnection,
  listConnectionSummaries,
} from "../vcs/connections";
import {
  deletePersonalToken,
  getPersonalTokenStatus,
  PersonalTokenError,
  savePersonalToken,
} from "../vcs/personal-token";
import { requireAuthenticatedUser } from "./auth";
import type { AppEnv } from "./deps";
import { redirectToOAuthStart, takeOAuthCallback } from "./oauth-cookie";

const OAUTH_STATE_COOKIE = "pca_vcs_oauth_state";
const personalTokenSchema = z.object({ token: z.string().trim().min(20).max(400) });

export function vcsRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("/github/pat", requireAuthenticatedUser);

  app.get("/github/pat", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "authentication required" }, 401);
    return c.json(
      await getPersonalTokenStatus(c.get("database"), c.get("config"), user, {
        fetchImpl: c.get("fetchImpl"),
      }),
    );
  });

  app.put("/github/pat", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "authentication required" }, 401);
    const parsed = personalTokenSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "a token is required" }, 400);
    try {
      return c.json(
        await savePersonalToken(c.get("database"), c.get("config"), user, parsed.data.token, {
          fetchImpl: c.get("fetchImpl"),
        }),
      );
    } catch (cause) {
      if (cause instanceof PersonalTokenError) return c.json({ error: cause.message }, 400);
      c.get("log").warn("personal token check failed", { error: cause });
      return c.json({ error: `GitHub request failed: ${errorMessage(cause)}` }, 502);
    }
  });

  app.delete("/github/pat", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "authentication required" }, 401);
    await deletePersonalToken(c.get("database"), user);
    return c.json({ ok: true });
  });

  app.get("/connections", async (c) => {
    const user = c.get("user");
    if (!user) {
      if (!c.get("config").auth.requireUser) return c.json({ connections: [] });
      return c.json({ error: "authentication required" }, 401);
    }
    return c.json(await listConnectionSummaries(c.get("database"), c.get("config"), user.id));
  });

  app.get("/connections/:provider/connect", async (c) =>
    redirectToOAuthStart(c, OAUTH_STATE_COOKIE, (userId) =>
      beginVcsConnection(c.get("database"), c.get("config"), c.req.param("provider"), userId),
    ),
  );

  app.get("/connections/:provider/callback", async (c) => {
    const provider = c.req.param("provider");
    const { state, code, error, savedState } = takeOAuthCallback(c, OAUTH_STATE_COOKIE);
    if (error) {
      return redirectToSettings(c, "connection_denied", oauthErrorMessage(c));
    }
    if (!state || !code || state !== savedState) {
      return redirectToSettings(c, "invalid_oauth_state");
    }

    try {
      const user = c.get("user");
      if (!user) return redirectToSettings(c, "authentication_required");
      await finishVcsConnection(
        c.get("database"),
        c.get("config"),
        provider,
        state,
        code,
        user.id,
      );
      return redirectToSettings(c, "connected");
    } catch (cause) {
      c.get("log").warn("VCS connection failed", { provider, error: cause });
      return redirectToSettings(c, "connection_failed", errorMessage(cause));
    }
  });

  app.delete("/connections/:provider", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "authentication required" }, 401);
    await disconnectVcsConnection(c.get("database"), user.id, c.req.param("provider"));
    return c.json({ ok: true });
  });

  return app;
}

function redirectToSettings(c: Context<AppEnv>, result: string, message?: string) {
  const params = new URLSearchParams({ connection: result });
  if (message) params.set("message", message);
  const url = `${c.get("config").web.url}/settings?${params.toString()}`;
  return c.redirect(url);
}

function oauthErrorMessage(c: Context<AppEnv>): string {
  const code = c.req.query("error")?.trim();
  const description = c.req.query("error_description")?.trim();
  const message =
    description && code
      ? `${description} (${code})`
      : description || code || "The provider denied the connection.";
  return message.slice(0, 240);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message.slice(0, 240) : String(cause).slice(0, 240);
}
