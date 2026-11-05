import type { PlatformCredentialSummary } from "@pi-cloud-agent/protocol";
import {
  inspectGithubToken,
  listGithubTokenRepositories,
  probeGithubRepoAccess,
} from "@pi-cloud-agent/vcs";
import type { Config } from "../config";
import type { Database } from "../db/client";
import {
  getPlatformCredential,
  insertPlatformCredential,
  listPlatformCredentials,
  updatePlatformCredential,
} from "../db/platform-credentials";
import type { PlatformRepoAccess, PlatformVcsCredentialRow } from "../db/schema";
import { decryptSecret, encryptSecret } from "../secrets/crypto";

/**
 * Operator-managed tokens the platform uses for built-in agents.
 *
 * A token is only as trustworthy as what git lets it do, so saving one means
 * asking GitHub per private repository whether the token can read or push.
 * The answer is stored; the operator sees it; agents are constrained by it.
 */

const PROVIDER = "github";
const MAX_PROBED_REPOS = 50;

interface Deps {
  fetchImpl: typeof fetch;
}

export class PlatformCredentialError extends Error {}

export async function probeAndSavePlatformCredential(
  database: Database,
  config: Config,
  input: { id?: string; label: string; token: string; updatedBy: string | null },
  deps: Deps,
): Promise<PlatformCredentialSummary> {
  const probed = await probeToken(input.token, deps);
  const fields = {
    provider: PROVIDER,
    label: input.label,
    accountId: probed.accountId,
    accountLogin: probed.accountLogin,
    accessToken: encryptSecret(input.token, config.vcs.encryptionKey),
    expiresAt: probed.expiresAt,
    repoAccess: probed.repoAccess,
    probedAt: new Date(),
    updatedBy: input.updatedBy,
  };
  if (input.id) {
    const row = await updatePlatformCredential(database, input.id, fields);
    if (!row) throw new PlatformCredentialError("credential not found");
    return summarize(row, config);
  }
  return summarize(await insertPlatformCredential(database, fields), config);
}

export async function reprobePlatformCredential(
  database: Database,
  config: Config,
  id: string,
  deps: Deps,
): Promise<PlatformCredentialSummary> {
  const row = await getPlatformCredential(database, id);
  if (!row) throw new PlatformCredentialError("credential not found");
  const token = decryptSecret(row.accessToken, config.vcs.encryptionKey);
  const probed = await probeToken(token, deps);
  const updated = await updatePlatformCredential(database, id, {
    accountId: probed.accountId,
    accountLogin: probed.accountLogin,
    expiresAt: probed.expiresAt,
    repoAccess: probed.repoAccess,
    probedAt: new Date(),
  });
  if (!updated) throw new PlatformCredentialError("credential not found");
  return summarize(updated, config);
}

export async function relabelPlatformCredential(
  database: Database,
  config: Config,
  id: string,
  label: string,
): Promise<PlatformCredentialSummary> {
  const row = await updatePlatformCredential(database, id, { label });
  if (!row) throw new PlatformCredentialError("credential not found");
  return summarize(row, config);
}

export async function listPlatformCredentialSummaries(
  database: Database,
  config: Config,
): Promise<PlatformCredentialSummary[]> {
  const rows = await listPlatformCredentials(database);
  return rows.map((row) => summarize(row, config));
}

/** The decrypted token for credential minting. Callers must wrap it in `Secret`. */
export async function decryptPlatformCredential(
  database: Database,
  config: Config,
  id: string,
): Promise<string> {
  const row = await getPlatformCredential(database, id);
  if (!row) throw new PlatformCredentialError("credential not found");
  return decryptSecret(row.accessToken, config.vcs.encryptionKey);
}

async function probeToken(
  token: string,
  deps: Deps,
): Promise<{
  accountId: string;
  accountLogin: string;
  expiresAt: Date | null;
  repoAccess: PlatformRepoAccess[];
}> {
  const info = await inspectGithubToken(token, deps);
  const repositories = (await listGithubTokenRepositories(token, deps))
    .filter((repository) => repository.isPrivate)
    .sort((left, right) => left.fullName.localeCompare(right.fullName))
    .slice(0, MAX_PROBED_REPOS);
  const repoAccess: PlatformRepoAccess[] = [];
  for (const repository of repositories) {
    const access = await probeGithubRepoAccess(token, repository.fullName, deps);
    if (access !== "none") repoAccess.push({ repo: repository.fullName, access });
  }
  return {
    accountId: info.accountId,
    accountLogin: info.login,
    expiresAt: info.expiresAt,
    repoAccess,
  };
}

function summarize(row: PlatformVcsCredentialRow, config: Config): PlatformCredentialSummary {
  const token = decryptSecret(row.accessToken, config.vcs.encryptionKey);
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    accountLogin: row.accountLogin,
    last4: token.slice(-4),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    probedAt: row.probedAt?.toISOString() ?? null,
    repoAccess: row.repoAccess,
  };
}
