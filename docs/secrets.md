# Secrets

## Current design

Users authenticate through the configured GitHub App. The controller creates a local application session and stores the GitHub App user access token encrypted in the user's `vcs_connections` row (provider `github`). Signing in establishes identity only; it grants no repository access. Azure DevOps can be connected from Settings and is stored against the same local user.

Three kinds of GitHub credential exist, all encrypted with `VCS_ENCRYPTION_KEY`, which is supplied only to the controller:

| Credential | Where | Who it acts as | Used for |
|---|---|---|---|
| GitHub App user token | `vcs_connections`, provider `github` | the signed-in user | reading and writing repositories in organizations where the App is installed |
| Personal access token | `vcs_connections`, provider `github-pat` | the signed-in user | developers' own repositories where the App is not installed; must belong to the signed-in account |
| Platform credential | `platform_vcs_credentials` | the operator's or a machine account | read-only access for built-in agents, one token per organization without an App installation |

`vcs/repository-access.ts` decides, per user and repository, which credential a task may use and whether it grants read or write. The order is the policy: the App user token where the App is installed, then the personal token, then a platform credential — and a platform credential only when its last probe said *read-only*, and only for read. A personal token that GitHub now rejects fails the request with a message pointing at Settings; the controller never silently substitutes another credential for a developer who believes they are pushing as themselves.

What a token can do is asked of git, not of the operator or of REST: saving a personal or platform token probes `info/refs?service=git-receive-pack` (push) and `git-upload-pack` (fetch) per repository, because REST's `permissions` block describes the account rather than the token. The probe never changes anything on GitHub.

The broker injects the chosen credential into the sandbox as `SCM_TOKEN` and provider-specific aliases, and sets `GIT_AUTHOR_*` / `GIT_COMMITTER_*` to the signed-in user's login and `noreply` address, so commits carry the person whichever token pushed them. Controller-owned reviews and comment replies still require short-lived App installation tokens minted from the private key, so GitHub attributes automation to the App; the private key never crosses into the sandbox.

Repository code and the agent share one untrusted machine. A personal token is scoped by whoever created it — a classic token reaches every repository its owner can — and lives as long as its owner chose, so a malicious repository can exfiltrate more than the old one-hour installation token could. Guide developers toward fine-grained tokens limited to the repositories they work on; keep platform credentials read-only and per organization.

Repository-specific dependencies belong in a user-selected base image/template. Settings **Test** runs a disposable compatibility check and destroys it. The image executes in the same untrusted sandbox as repository code, so image authors must be trusted. Provider checkpoints are filesystem-only and must not retain credential values.

## Security concerns

These are known limitations, not solved problems:

- A sandbox can exfiltrate the credential it was given while a run is active: the user's App token (about eight hours, refreshed by the controller), their personal token (as scoped and as long-lived as they made it), or a platform credential (read-only by construction, but reaching every private repository it was probed against). Eliminating token visibility entirely requires an authenticated Git transport proxy outside the sandbox. Do not treat redaction as containment.
- A personal token is accepted only if `GET /user` returns the signed-in account's id, so one user cannot commit as another by pasting a colleague's token. Nothing stops a user from pasting a token broader than they need; Settings recommends fine-grained tokens for that reason.
- A platform credential's `repo_access` is a snapshot from its last probe. Access granted or revoked on GitHub afterwards is not seen until an operator re-probes; a token that gained push rights after being saved would still be labelled read-only until then.
- GitHub App permissions are intentionally narrow but Contents read/write still permits repository mutation. The App installation's repository selection is an additional policy boundary.
- Operators (`OPERATOR_GITHUB_LOGINS`) can read every platform credential's label, account and per-repository access, and can replace tokens. They cannot read token values through the API.
- Azure DevOps permissions are delegated through the Microsoft Entra app and must be reviewed separately for least privilege.
- Disconnect deletes the local connection but does not yet revoke the provider token. Add provider-side revocation to the broker/provider adapter.
- Database backups, logs, crash dumps, controller memory, and OAuth client secrets are sensitive. Never return or log them.
- The runtime must not persist model OAuth credentials in the parked session workspace. Pi may use a run-scoped temporary auth file during a turn. A rotated credential is returned only through the authenticated run callback using compare-and-set persistence, and the file is removed before the sandbox can be suspended.
- Session cookies are signed and HttpOnly. Local HTTP uses `SameSite=Lax`; HTTPS uses `SameSite=None` so a dashboard hosted on another site can call the controller. The controller requires an allowed `Origin` on authenticated state-changing browser requests, and `WEB_CORS_ORIGINS` must contain explicit origins rather than `*`. `APP_SESSION_SECRET` must be at least 32 characters and must be rotated using a planned session invalidation procedure.

## Application isolation

The application user is established by the GitHub App callback. VCS connections, runs, sessions, repository discovery, and dashboard reads are scoped by that user's database id. Internal sandbox callbacks use a separate per-run callback token and are not authenticated by the browser session.

## Plugin MCP OAuth

Host-mediated plugin OAuth reuses the same encryption key (`VCS_ENCRYPTION_KEY`) and stores access/refresh tokens in `plugin_oauth_tokens` plus a copy of the access token in `plugin_user_variables` under the manifest `tokenVariable`.

- Authorization-server hosts must be listed in `PLUGIN_OAUTH_ISSUER_ALLOWLIST`.
- Tokens must never appear in `run_events`, logs, or audit detail payloads.
- Dynamic client registration caches `client_id` in `plugin_oauth_clients` (public client, PKCE only — no client secret).

## Planned secrets broker

The next hardening step is a broker-backed Git transport or egress proxy that authorizes a repository operation and injects credentials entirely outside the sandbox. That removes the token — personal, App or platform — from the repository process boundary, which matters more now that personal tokens can outlive a run by months.

The seam is `CredentialBroker` in `apps/controller/secrets/broker.ts`. Keep the reconciler dependent on that small interface so the broker can change without spreading secret policy through run orchestration.
