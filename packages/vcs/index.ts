import type { VCSProvider } from "@pi-cloud-agent/protocol";
import { createAzureDevOpsProvider } from "./azure-devops";
import { createGitHubProvider } from "./github";
import type { ForgeHttpDeps } from "./http";

type Factory = (accessToken: string, deps?: ForgeHttpDeps) => VCSProvider;

const FACTORIES: Record<string, Factory> = {
  "azure-devops": createAzureDevOpsProvider,
  github: createGitHubProvider,
};

export function createVcsProvider(
  name: string,
  accessToken: string,
  deps: ForgeHttpDeps = {},
): VCSProvider {
  const factory = FACTORIES[name];
  if (!factory) {
    const known = Object.keys(FACTORIES).sort().join(", ");
    throw new Error(`Unknown VCS provider "${name}". Available: ${known}.`);
  }
  return factory(accessToken, deps);
}

export { createAzureDevOpsProvider } from "./azure-devops";
export type {
  GithubAppCredentials,
  GithubCommentPublisher,
  GithubInstallation,
  GithubPullRequestRevision,
  GithubReviewPublisher,
} from "./github";
export {
  createGitHubProvider,
  createGithubCommentPublisher,
  createGithubInstallationToken,
  createGithubReviewPublisher,
  fetchGithubPullRequestRevision,
  verifyGithubInstallation,
} from "./github";
export type { GithubOpenPull, GithubReviewReader } from "./github-repositories";
export { createGithubReviewReader, githubAppInstallUrl } from "./github-repositories";
export type {
  GithubTokenDeps,
  GithubTokenInfo,
  GithubTokenKind,
  GithubTokenRepository,
  RepoAccess,
} from "./github-token";
export {
  githubTokenKind,
  inspectGithubToken,
  listGithubTokenRepositories,
  probeGithubRepoAccess,
} from "./github-token";
export type { ForgeHttpDeps } from "./http";
export { createVcsOAuthProvider } from "./oauth";

export function vcsProviderNames(): string[] {
  return Object.keys(FACTORIES).sort();
}
