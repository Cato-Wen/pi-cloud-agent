import type { PlatformCredentialsResponse } from "@pi-cloud-agent/protocol";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { requireOperator } from "../auth/operator";
import { deletePlatformCredential, getPlatformCredential } from "../db/platform-credentials";
import {
  listPlatformCredentialSummaries,
  PlatformCredentialError,
  probeAndSavePlatformCredential,
  relabelPlatformCredential,
  reprobePlatformCredential,
} from "../vcs/platform-credentials";
import type { AppEnv } from "./deps";

/** Operator-only administration: platform credentials today, agents and skills next. */

const createSchema = z.object({
  label: z.string().trim().min(1).max(80),
  token: z.string().trim().min(20).max(400),
});
const updateSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  token: z.string().trim().min(20).max(400).optional(),
});

export function adminRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requireOperator);

  app.get("/credentials", async (c) => {
    const response: PlatformCredentialsResponse = {
      credentials: await listPlatformCredentialSummaries(c.get("database"), c.get("config")),
    };
    return c.json(response);
  });

  app.post("/credentials", async (c) => {
    const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "label and token are required" }, 400);
    return attempt(c, 201, () =>
      probeAndSavePlatformCredential(
        c.get("database"),
        c.get("config"),
        { ...parsed.data, updatedBy: c.get("user")?.id ?? null },
        { fetchImpl: c.get("fetchImpl") },
      ),
    );
  });

  app.put("/credentials/:id", async (c) => {
    const parsed = updateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success || (!parsed.data.label && !parsed.data.token)) {
      return c.json({ error: "provide a label or a token" }, 400);
    }
    const id = c.req.param("id");
    const { label, token } = parsed.data;
    return attempt(c, 200, async () => {
      const existing = await getPlatformCredential(c.get("database"), id);
      if (!existing) throw new PlatformCredentialError("credential not found");
      if (!token) {
        return relabelPlatformCredential(c.get("database"), c.get("config"), id, label ?? "");
      }
      return probeAndSavePlatformCredential(
        c.get("database"),
        c.get("config"),
        { id, label: label ?? existing.label, token, updatedBy: c.get("user")?.id ?? null },
        { fetchImpl: c.get("fetchImpl") },
      );
    });
  });

  app.post("/credentials/:id/probe", async (c) =>
    attempt(c, 200, () =>
      reprobePlatformCredential(c.get("database"), c.get("config"), c.req.param("id"), {
        fetchImpl: c.get("fetchImpl"),
      }),
    ),
  );

  app.delete("/credentials/:id", async (c) => {
    const removed = await deletePlatformCredential(c.get("database"), c.req.param("id"));
    if (!removed) return c.json({ error: "credential not found" }, 404);
    return c.json({ ok: true });
  });

  return app;
}

async function attempt(
  c: Context<AppEnv>,
  status: 200 | 201,
  work: () => Promise<unknown>,
): Promise<Response> {
  try {
    return c.json(await work(), status);
  } catch (cause) {
    if (cause instanceof PlatformCredentialError) {
      return c.json({ error: cause.message }, cause.message.includes("not found") ? 404 : 400);
    }
    c.get("log").warn("platform credential request failed", { error: cause });
    const message = cause instanceof Error ? cause.message : String(cause);
    return c.json({ error: `GitHub request failed: ${message}` }, 502);
  }
}
