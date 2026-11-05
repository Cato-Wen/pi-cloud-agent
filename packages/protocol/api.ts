import { z } from "zod";
import type { RunEvent } from "./events";
import { type ThinkingLevel, thinkingLevelSchema } from "./llm";
import type { VcsRepository } from "./repo";
import type { RunStatus } from "./run";

/**
 * The controller's HTTP surface, shared with the dashboard.
 *
 * The web app imports these types instead of restating them, which is the whole
 * reason a protocol package exists: there is one definition of a run, and it
 * cannot drift between the server that writes it and the client that renders it.
 */

export const createRunRequestSchema = z.object({
  /** Provider-specific full repository name. */
  repo: z.string().min(3),
  prompt: z.string().min(1),
  provider: z.string().default("github"),
  /** Branch to clone. Omitted means "ask the provider for the default". */
  branch: z.string().nullish(),
  /** User-owned model connection. Required for every task. */
  modelConnectionId: z.string().uuid(),
  /** Model selected from the connection's available model catalog. */
  modelId: z.string().min(1),
  thinkingLevel: thinkingLevelSchema,
});

export type CreateRunRequest = z.input<typeof createRunRequestSchema>;
export type CreateRunBody = z.output<typeof createRunRequestSchema>;

export const createSessionTurnRequestSchema = z.object({
  prompt: z.string().trim().min(1),
  /** User-owned model connection selected for this turn. */
  modelConnectionId: z.string().uuid(),
  /** Model selected from the connection's current catalog. */
  modelId: z.string().min(1),
  thinkingLevel: thinkingLevelSchema,
});

export type CreateSessionTurnRequest = z.infer<typeof createSessionTurnRequestSchema>;

export const updateSessionPinRequestSchema = z.object({
  pinned: z.boolean(),
});

export type UpdateSessionPinRequest = z.infer<typeof updateSessionPinRequestSchema>;

export const sessionCheckpointSchema = z.object({
  content: z.string().max(20_000_000),
});

export type SessionCheckpoint = z.infer<typeof sessionCheckpointSchema>;

export interface RunSummary {
  id: string;
  status: RunStatus;
  provider: string;
  repo: string;
  /** Resolved when the run was created, so it stays accurate if config changes. */
  model: string;
  modelConnectionId: string | null;
  thinkingLevel: ThinkingLevel;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  sessionId: string | null;
  turnNumber: number | null;
}

export interface RunDetail extends RunSummary {
  /** The request the agent was given, when the trigger carried one. */
  prompt: string | null;
  /** Branch the run cloned (or the repo default when none was pinned). */
  branch: string | null;
  headSha: string | null;
  /** Set once a sandbox exists; cleared conceptually when it is reclaimed. */
  sandboxStoppedAt: string | null;
}

export interface RunListResponse {
  runs: RunSummary[];
}

export interface RunEventsResponse {
  events: RunEvent[];
}

export type SessionStatus = "idle" | "queued" | "provisioning" | "running" | "parking";
export type SessionRetentionStatus = "active" | "inactive";

export interface SessionSummary {
  id: string;
  /** A PR conversation remains in Reviews even after a manual follow-up. */
  hasReviews: boolean;
  status: SessionStatus;
  retentionStatus: SessionRetentionStatus;
  /** Seconds without activity before the provider checkpoint is released. */
  inactiveAfterSeconds: number;
  pinned: boolean;
  title: string;
  provider: string;
  repo: string;
  model: string;
  modelConnectionId: string | null;
  activeRunId: string | null;
  latestRunId: string;
  workspaceAvailable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SessionDetail extends SessionSummary {
  runs: RunDetail[];
}

export interface SessionListResponse {
  sessions: SessionSummary[];
}

export interface ReposResponse {
  /** `access` says what the signed-in user's credentials allow; absent for anonymous reads. */
  repos: Array<VcsRepository & { access?: "write" | "read" }>;
  /** Where the list came from: a connected identity or nothing. */
  source: "connection" | "none";
}

export interface VcsConnectionSummary {
  provider: string;
  displayName: string;
  configured: boolean;
  connected: boolean;
  accountName: string | null;
}

export interface VcsConnectionsResponse {
  connections: VcsConnectionSummary[];
}

export interface AppUserSummary {
  id: string;
  login: string;
  displayName: string;
  avatarUrl: string | null;
  isOperator?: boolean;
  /** Whether a personal GitHub token is bound; drives onboarding, not access. */
  hasPat?: boolean;
}

/** `vcs_connections.provider` for a user's personal GitHub token. */
export const PAT_PROVIDER = "github-pat";

export interface PersonalTokenStatus {
  connected: boolean;
  kind: "classic" | "fine-grained" | "unknown" | null;
  login: string | null;
  last4: string | null;
  /** Classic scopes only; fine-grained tokens report none. */
  scopes: string[];
  /** ISO timestamp, or null when the token does not expire. */
  expiresAt: string | null;
  /** `invalid` means GitHub rejects the stored token now. */
  state: "none" | "valid" | "invalid";
  /** Fine-grained token that sees no private repository: likely awaiting org approval. */
  pendingHint: boolean;
  /** Repositories the token's account can push to, by full name. */
  writableRepos: string[];
}

/** An operator-managed token the platform uses for agents; never carries the token itself. */
export interface PlatformCredentialSummary {
  id: string;
  provider: string;
  label: string;
  accountLogin: string;
  last4: string;
  expiresAt: string | null;
  probedAt: string | null;
  /** What git allowed per private repository when last probed. */
  repoAccess: Array<{ repo: string; access: "read" | "write" }>;
}

export interface PlatformCredentialsResponse {
  credentials: PlatformCredentialSummary[];
}

export interface PluginCatalogEntry {
  name: string;
  publisher: string;
  version: string;
  versionId: string;
  source: string;
  components: { skills: boolean; mcp: boolean };
  reviewStatus: "draft" | "approved" | "yanked";
  installMode: "default_off" | "default_on" | "required";
  description: string;
  variables: unknown;
  oauth: {
    required: boolean;
    connected: boolean;
    connectPath: string | null;
    tokenVariable: string | null;
  };
  user: {
    installed: boolean;
    override: "enabled" | "disabled" | null;
    attached: boolean;
    configuredVariables: string[];
  };
}

export interface PluginCatalogResponse {
  plugins: PluginCatalogEntry[];
  isOperator: boolean;
}

export interface BranchesResponse {
  branches: string[];
  default: string | null;
}

export const updateRepositoryEnvironmentRequestSchema = z.object({
  provider: z.string().min(1),
  repo: z.string().min(3),
  imageRef: z
    .string()
    .trim()
    .max(500)
    .refine(
      (value) =>
        Array.from(value).every((char) => {
          const code = char.charCodeAt(0);
          return code >= 32 && code !== 127;
        }),
      "image reference contains control characters",
    ),
});

export type UpdateRepositoryEnvironmentRequest = z.infer<
  typeof updateRepositoryEnvironmentRequestSchema
>;

export interface RepositoryEnvironmentSummary {
  provider: string;
  repo: string;
  imageRef: string;
  updatedAt: string;
}

export interface RepositoryEnvironmentsResponse {
  environments: RepositoryEnvironmentSummary[];
}
