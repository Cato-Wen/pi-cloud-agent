import { asc, eq } from "drizzle-orm";
import type { Database } from "./client";
import { type PlatformVcsCredentialRow, platformVcsCredentials } from "./schema";

export async function listPlatformCredentials(
  database: Database,
): Promise<PlatformVcsCredentialRow[]> {
  return database
    .select()
    .from(platformVcsCredentials)
    .orderBy(asc(platformVcsCredentials.createdAt));
}

export async function getPlatformCredential(
  database: Database,
  id: string,
): Promise<PlatformVcsCredentialRow | null> {
  const [row] = await database
    .select()
    .from(platformVcsCredentials)
    .where(eq(platformVcsCredentials.id, id))
    .limit(1);
  return row ?? null;
}

export async function insertPlatformCredential(
  database: Database,
  input: Omit<PlatformVcsCredentialRow, "id" | "createdAt" | "updatedAt">,
): Promise<PlatformVcsCredentialRow> {
  const [row] = await database.insert(platformVcsCredentials).values(input).returning();
  if (!row) throw new Error("platform credential insert returned no row");
  return row;
}

export async function updatePlatformCredential(
  database: Database,
  id: string,
  patch: Partial<Omit<PlatformVcsCredentialRow, "id" | "createdAt" | "updatedAt">>,
): Promise<PlatformVcsCredentialRow | null> {
  const [row] = await database
    .update(platformVcsCredentials)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(platformVcsCredentials.id, id))
    .returning();
  return row ?? null;
}

export async function deletePlatformCredential(
  database: Database,
  id: string,
): Promise<boolean> {
  const rows = await database
    .delete(platformVcsCredentials)
    .where(eq(platformVcsCredentials.id, id))
    .returning({ id: platformVcsCredentials.id });
  return rows.length > 0;
}

/** Credentials whose last probe reached this repository. Few rows; filtered in memory. */
export async function findPlatformCredentialsForRepo(
  database: Database,
  provider: string,
  repoFullName: string,
): Promise<PlatformVcsCredentialRow[]> {
  const rows = await listPlatformCredentials(database);
  const wanted = repoFullName.toLowerCase();
  return rows.filter(
    (row) =>
      row.provider === provider &&
      row.repoAccess.some((entry) => entry.repo.toLowerCase() === wanted),
  );
}
