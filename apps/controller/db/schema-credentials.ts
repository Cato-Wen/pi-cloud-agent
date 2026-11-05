import {
  type AnyPgColumn,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** One repository the credential was probed against, and what git let it do. */
export interface PlatformRepoAccess {
  repo: string;
  access: "read" | "write";
}

/**
 * Everything that holds a forge credential or the state to obtain one.
 *
 * `vcs_connections` are per-user tokens: the GitHub App sign-in (provider
 * `github`), a personal token (`github-pat`), Azure DevOps. `oauth_states`
 * are the short-lived PKCE records behind those sign-ins.
 * `platform_vcs_credentials` are operator tokens used on behalf of built-in
 * agents, one per organization without a GitHub App installation; each is
 * probed per private repository at save time, so `repo_access` is what git
 * actually allowed — not what the operator believed when pasting it.
 */
export function defineCredentialTables(userReference: () => AnyPgColumn) {
  const vcsConnections = pgTable(
    "vcs_connections",
    {
      id: uuid("id").primaryKey().defaultRandom(),
      userId: uuid("user_id").references(userReference, { onDelete: "cascade" }),
      provider: text("provider").notNull(),
      accountId: text("account_id").notNull(),
      accountName: text("account_name").notNull(),
      accessToken: text("access_token").notNull(),
      refreshToken: text("refresh_token"),
      expiresAt: timestamptz("expires_at"),
      createdAt: timestamptz("created_at").notNull().defaultNow(),
      updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    },
    (table) => [
      uniqueIndex("vcs_connections_user_provider_idx").on(table.userId, table.provider),
    ],
  );

  const oauthStates = pgTable(
    "oauth_states",
    {
      state: text("state").primaryKey(),
      userId: uuid("user_id").references(userReference, { onDelete: "cascade" }),
      provider: text("provider").notNull(),
      returnTo: text("return_to"),
      codeVerifier: text("code_verifier").notNull(),
      expiresAt: timestamptz("expires_at").notNull(),
      createdAt: timestamptz("created_at").notNull().defaultNow(),
    },
    (table) => [index("oauth_states_expiry_idx").on(table.expiresAt)],
  );

  const platformVcsCredentials = pgTable("platform_vcs_credentials", {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    label: text("label").notNull(),
    accountId: text("account_id").notNull(),
    accountLogin: text("account_login").notNull(),
    /** Encrypted with VCS_ENCRYPTION_KEY, like user connections. */
    accessToken: text("access_token").notNull(),
    expiresAt: timestamptz("expires_at"),
    repoAccess: jsonb("repo_access").notNull().default([]).$type<PlatformRepoAccess[]>(),
    probedAt: timestamptz("probed_at"),
    updatedBy: uuid("updated_by").references(userReference, { onDelete: "set null" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  });

  return { vcsConnections, oauthStates, platformVcsCredentials };
}
