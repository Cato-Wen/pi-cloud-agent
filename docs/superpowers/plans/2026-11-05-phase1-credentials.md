# 阶段 1：凭证基础（个人 PAT + 平台凭证）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 开发者绑定个人 GitHub token 后，无需 GitHub App 安装即可用本人身份选仓库、跑任务、commit / push；管理员可录入平台 token 并自动探测它对每个仓库是只读还是可写。

**Architecture:** 新增 `packages/vcs/github-token.ts`（token 检查 + git 探测，纯 HTTP，注入 `fetch`）；controller 新增 `vcs/personal-token.ts`、`vcs/platform-credentials.ts`、`vcs/repository-access.ts`（统一的"用户 × 仓库 → 凭证"判定），`http/admin.ts`（operator 路由）；`secrets/broker.ts` 改为通过判定函数签发凭证并注入 git 作者；web 加 PAT 卡片和 Admin › Credentials 页。GitHub App 路径完整保留。

**Tech Stack:** TypeScript、Hono、Drizzle + Postgres、Vitest（unit / integration）、Next.js + Tailwind、zod。

**Spec:** `docs/design/repository-access.md`（§2.2、§4、§12、§13 阶段 1）；交互见 `docs/design/prd.md` §7.3、§7.6、§7.7。

## Global Constraints

- 所有 token 一律用 `Secret`（`packages/protocol/secret.ts`）包装进入 env / 日志；API 响应只回末 4 位。
- 不 mock 模块；GitHub 调用通过注入的 `fetchImpl: typeof fetch` 替换（`docs/testing.md`）。
- 单个源文件 ≤ 500 行（`pnpm files:check`）；`apps/controller/db/schema.ts` 已 448 行，新表放 `schema-credentials.ts`。
- 测试命名：描述承诺，不描述函数（`it("…lets…")`）。集成测试用 `apps/controller/test-support.ts` 的 `setupTestDatabase` / `resetTables` / `testConfig` / `seedTestUser`。
- 环境变量名 `OPERATOR_GITHUB_LOGINS` 不变。
- 个人 PAT 存 `vcs_connections`，`provider = "github-pat"`；`account_id` 必须等于 `app_users.github_user_id`。
- 只读 / 可写判定一律用 git 探测：`GET https://github.com/{owner}/{repo}.git/info/refs?service=git-receive-pack`（200 = 可写，401/403 = 不可写）、`service=git-upload-pack`（200 = 可读）。Basic 认证，用户名 `x-access-token`。
- 平台凭证探测只保留私有仓库；每个凭证最多探测 50 个仓库。
- 凭证顺序（§4.4）：App 用户 token → 本人 PAT → 平台只读凭证 → 拒绝。开发模式主仓库需要 write；PAT 失效时报错，不退回。
- git 作者：`GIT_AUTHOR_NAME`/`GIT_COMMITTER_NAME` = `app_users.login`；`GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_EMAIL` = `<github_user_id>+<login>@users.noreply.github.com`。
- 提交信息末尾加 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。
- 完成每个任务后 `pnpm lint && pnpm typecheck` 必须通过；最终 `pnpm verify` 通过。

## Review Focus

1. **别人的 token 冒充提交**：PAT 的 `GET /user` id ≠ 登录人 `github_user_id` → `PUT /vcs/github/pat` 返回 400，不写库。（Task 3）
2. **PAT 过期后悄悄降级**：PAT 返回 401 时创建任务必须 422 并提示更新，不得退回平台凭证或 App token。（Task 5）
3. **可写 token 被录成只读凭证**：平台凭证探测到 receive-pack 200 的仓库要标 `write`，判定函数在 `need='read'` 时不得挑选它去跑"只读"任务（优先只读凭证；没有只读凭证则拒绝）。（Task 4、5）
4. **token 泄漏到响应 / 日志**：所有状态接口只返回 `last4`；`Secret` 的 `toString` 已脱敏，broker 返回 `Secret`。（Task 3、4、5）
5. **fine-grained 等待审批被当成有效**：fine-grained 且可见私有仓库为 0 → 状态返回 `pendingHint: true`，前端提示。（Task 3）

---

### Task 1: `isOperator` 挪到 auth 模块

**Files:**
- Create: `apps/controller/auth/operator.ts`、`apps/controller/auth/operator.test.ts`
- Modify: `apps/controller/config.ts`（`Config.auth` 加 `operatorLogins: string[]`，从 `plugins` 移走）、`apps/controller/plugins/marketplace.ts:427-430`（删除 `isOperator`）、`apps/controller/http/plugins.ts:8,203`、`apps/controller/http/auth.ts:5`、`apps/controller/test-support.ts`（如有引用）

**Interfaces:**
- Produces: `isOperator(config: Config, login: string | undefined): boolean`；`requireOperator(c: Context<AppEnv>, next: Next): Promise<void>`（非 operator 返回 `403 { error: "operator access required" }`）。
- `config.auth.operatorLogins: string[]`（小写）。

- [ ] **Step 1: 写失败测试** `apps/controller/auth/operator.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { testConfig } from "../test-support";
import { isOperator } from "./operator";

describe("operator access", () => {
  it("matches logins case-insensitively from OPERATOR_GITHUB_LOGINS", () => {
    const config = testConfig({ OPERATOR_GITHUB_LOGINS: "Cato-Wen, alice" });
    expect(isOperator(config, "cato-wen")).toBe(true);
    expect(isOperator(config, "ALICE")).toBe(true);
    expect(isOperator(config, "bob")).toBe(false);
    expect(isOperator(config, undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败** `pnpm vitest run apps/controller/auth/operator.test.ts` → FAIL（模块不存在）
- [ ] **Step 3: 实现** `auth/operator.ts`：`isOperator` 读 `config.auth.operatorLogins`；`requireOperator` 中间件。`config.ts`：`auth.operatorLogins` 由 `OPERATOR_GITHUB_LOGINS` 解析（原 plugins 里的逻辑搬过来），`plugins.operatorLogins` 删除。更新三处 import。
- [ ] **Step 4: 运行** 上述测试 + `pnpm vitest run apps/controller/plugins` → PASS；`pnpm typecheck` 通过
- [ ] **Step 5: Commit** `refactor: move operator check into auth module`

---

### Task 2: GitHub token 检查与 git 探测（`packages/vcs`）

**Files:**
- Create: `packages/vcs/github-token.ts`、`packages/vcs/github-token.test.ts`
- Modify: `packages/vcs/index.ts`（导出）、`packages/vcs/README.md`（文件表加一行）

**Interfaces:**
- Produces:

```ts
export type GithubTokenKind = "classic" | "fine-grained" | "unknown";
export interface GithubTokenInfo {
  accountId: string; login: string; kind: GithubTokenKind;
  scopes: string[];            // 仅 classic；来自 X-OAuth-Scopes
  expiresAt: Date | null;      // 来自 GitHub-Authentication-Token-Expiration
}
export interface GithubTokenRepository {
  fullName: string; defaultBranch: string | null; isPrivate: boolean; canPush: boolean; // canPush = permissions.push
}
export type RepoAccess = "write" | "read" | "none";
export interface GithubTokenDeps { fetchImpl?: typeof fetch }

export function githubTokenKind(token: string): GithubTokenKind;   // ghp_ → classic, github_pat_ → fine-grained
export async function inspectGithubToken(token: string, deps?: GithubTokenDeps): Promise<GithubTokenInfo>; // 401 → throw Error("GitHub rejected the token")
export async function listGithubTokenRepositories(token: string, deps?: GithubTokenDeps): Promise<GithubTokenRepository[]>; // /user/repos 分页 ≤5 页
export async function probeGithubRepoAccess(token: string, repoFullName: string, deps?: GithubTokenDeps): Promise<RepoAccess>;
```

- [ ] **Step 1: 写失败测试** `github-token.test.ts`，用一个 `fakeFetch(routes)` 本地 helper（按 URL 前缀返回 `Response`）：

```ts
it("reads account, kind, scopes and expiry from GET /user", ...)
  // headers: "x-oauth-scopes": "repo, workflow", "github-authentication-token-expiration": "2026-12-05 08:10:35 UTC"
  // expect kind "classic", scopes ["repo","workflow"], expiresAt ISO 2026-12-05T08:10:35.000Z, accountId "104287479"
it("rejects a token GitHub does not accept", ...)   // 401 → rejects.toThrow(/rejected/)
it("classifies write when receive-pack answers 200 and read when only upload-pack does", ...)
  // receive 200 → "write"; receive 403 + upload 200 → "read"; both 401 → "none"
it("sends basic auth with the x-access-token username to github.com", ...)
  // 断言 Authorization === "Basic " + base64("x-access-token:" + token)
it("keeps only private repositories' push flag and stops paging under 100 items", ...)
```

- [ ] **Step 2: 运行确认失败** `pnpm vitest run packages/vcs/github-token.test.ts`
- [ ] **Step 3: 实现** `github-token.ts`。直接用 `fetchImpl`（不用 `fetchJson`，需要读头和状态码）；GitHub 日期格式 `YYYY-MM-DD HH:mm:ss UTC` → `new Date(value.replace(" UTC","Z").replace(" ","T"))`。探测请求用 `GET`，`redirect: "manual"`，超时 15s。
- [ ] **Step 4: 运行** → PASS；`pnpm lint`
- [ ] **Step 5: Commit** `feat(vcs): inspect GitHub tokens and probe repository access`

---

### Task 3: 个人 PAT 保存、状态、删除

**Files:**
- Create: `apps/controller/vcs/personal-token.ts`、`apps/controller/http/personal-token.integration.test.ts`、`apps/controller/test-support-github.ts`
- Modify: `apps/controller/http/vcs.ts`（三条路由）、`apps/controller/http/deps.ts`（`Deps.fetchImpl?: typeof fetch`；`createApp` 里 `c.set("fetchImpl", deps.fetchImpl ?? fetch)`）、`apps/controller/http/app.ts`、`packages/protocol/api.ts`（类型）、`apps/controller/http/auth.ts`（`/me` 加 `hasPat`）

**Interfaces:**
- Consumes: Task 2 的四个函数；`db/vcs-connections.ts` 的 `upsertVcsConnection` / `getVcsConnection` / `deleteVcsConnection`；`secrets/crypto.ts`。
- Produces（protocol/api.ts）:

```ts
export interface PersonalTokenStatus {
  connected: boolean;
  kind: "classic" | "fine-grained" | "unknown" | null;
  login: string | null; last4: string | null; scopes: string[];
  expiresAt: string | null;              // ISO
  state: "none" | "valid" | "invalid";   // invalid = GitHub 现在拒绝它
  pendingHint: boolean;                  // fine-grained 且可见私有仓库为 0
  writableRepos: string[];               // canPush 的 fullName，≤ 100
}
export const PAT_PROVIDER = "github-pat";
```

  `AppUserSummary` 加 `hasPat?: boolean`。
- Produces（personal-token.ts）:

```ts
export async function savePersonalToken(database, config, user: AppUserRow, token: string, deps: { fetchImpl: typeof fetch }): Promise<PersonalTokenStatus>;
  // 校验：inspect → accountId !== user.githubUserId → throw PersonalTokenError("token belongs to another GitHub account")
  //       classic 且 scopes 不含 "repo" → throw PersonalTokenError("classic token needs the repo scope")
  // 存：upsertVcsConnection({ provider: PAT_PROVIDER, accountId, accountName: login, accessToken: encryptSecret(token), refreshToken: null, expiresAt })
export async function getPersonalTokenStatus(database, config, user, deps): Promise<PersonalTokenStatus>;  // 无行 → state "none"；inspect 401 → "invalid"
export async function deletePersonalToken(database, user): Promise<void>;
export async function getPersonalToken(database, config, userId: string): Promise<{ token: string; login: string } | null>;  // 解密，给 Task 5 用
export class PersonalTokenError extends Error {}  // 路由映射为 400
```

- `test-support-github.ts`：`fakeGithubFetch(spec: { user: { id: number; login: string }; tokenKind?: "classic"|"fine-grained"; scopes?: string; expires?: string; repos: Array<{ full_name: string; private: boolean; push: boolean; default_branch?: string }>; push?: Record<string, number>; read?: Record<string, number>; rejectToken?: boolean }): typeof fetch`。按 URL 路由：`/user`、`/user/repos`、`github.com/*.git/info/refs?service=…`；未知 URL 返回 404。可按 token 值区分（`spec` 可以是 `Record<token, spec>`）。

- [ ] **Step 1: 写失败集成测试** `personal-token.integration.test.ts`（用 `createApp({ …, fetchImpl: fakeGithubFetch(...) })`，Cookie 来自 `seedTestUser`，注意 `seedTestUser` 的 `githubUserId` 是 `"default-test-user"`，fake 的 `user.id` 要对应——给 `fakeGithubFetch` 的 `user.id` 允许 string）：

```ts
it("stores a token that belongs to the signed-in account and reports what it can write", ...)
  // PUT /vcs/github/pat { token: "ghp_abc…L18g" } → 200；body.state "valid"、last4 "L18g"、writableRepos ["food-truck/master-data-management"]、scopes 含 "repo"
  // 然后 GET /auth/me → hasPat true；GET /vcs/github/pat → connected true
it("refuses a token created by a different GitHub account", ...)          // user.id 不同 → 400，GET 仍 connected false
it("refuses a classic token without the repo scope", ...)                // scopes "gist" → 400
it("flags a fine-grained token that cannot see any private repository as possibly pending approval", ...) // pendingHint true
it("reports invalid when GitHub now rejects the stored token", ...)      // 先存成功，再换 rejectToken fetch 建新 app → GET state "invalid"
it("never echoes the token back", ...)                                   // JSON.stringify(body) 不含完整 token
it("removes the token", ...)                                             // DELETE → GET connected false
```

- [ ] **Step 2: 运行确认失败** `pnpm vitest run --project integration apps/controller/http/personal-token.integration.test.ts`
- [ ] **Step 3: 实现** 服务 + 路由（`GET/PUT/DELETE /vcs/github/pat`，PUT body `{ token: string }` 用 zod，`PersonalTokenError` → 400，其他错误 → 502 `"GitHub request failed"`）+ `/me.hasPat` + `Deps.fetchImpl`。
- [ ] **Step 4: 运行** → PASS；`pnpm vitest run --project integration apps/controller/http/api.integration.test.ts` 仍 PASS
- [ ] **Step 5: Commit** `feat: let users bind a personal GitHub token`

---

### Task 4: 平台凭证：表、探测、管理接口

**Files:**
- Create: `apps/controller/db/schema-credentials.ts`、`apps/controller/db/platform-credentials.ts`、`apps/controller/vcs/platform-credentials.ts`、`apps/controller/http/admin.ts`、`apps/controller/http/admin.integration.test.ts`
- Create（生成）: `apps/controller/db/migrations/0029_*.sql`（`pnpm --filter @pi-cloud-agent/controller db:generate`，需要 `.env` 的 `DATABASE_URL`）
- Modify: `apps/controller/db/schema.ts`（`export const platformVcsCredentials = definePlatformCredentials(() => appUsers.id)` + `PlatformVcsCredentialRow` 类型）、`apps/controller/test-support.ts`（`resetTables` truncate 列表加 `platform_vcs_credentials`）、`apps/controller/http/app.ts`（`app.route("/admin", adminRoutes())`）、`packages/protocol/api.ts`

**Interfaces:**
- 表（§4.2）：`platform_vcs_credentials(id uuid pk, provider text, label text, account_id text, account_login text, access_token text, expires_at timestamptz, repo_access jsonb default '[]', probed_at timestamptz, updated_by uuid → app_users.id set null, created_at, updated_at)`；`repo_access` 类型 `Array<{ repo: string; access: "read" | "write" }>`。
- db 层：`listPlatformCredentials(db)`, `getPlatformCredential(db, id)`, `insertPlatformCredential(db, row)`, `updatePlatformCredential(db, id, patch)`, `deletePlatformCredential(db, id)`, `findPlatformCredentialsForRepo(db, provider, repoFullName): Promise<PlatformVcsCredentialRow[]>`（jsonb `@>` 查询或在应用层过滤——用应用层过滤，行数很少）。
- 服务：

```ts
export async function probeAndSavePlatformCredential(database, config, input: { id?: string; label: string; token: string; updatedBy: string | null }, deps: { fetchImpl: typeof fetch }): Promise<PlatformCredentialSummary>;
  // inspect → listGithubTokenRepositories → 只保留 isPrivate → 前 50 个逐个 probeGithubRepoAccess → repo_access（"none" 的不记）
export async function reprobePlatformCredential(database, config, id, deps): Promise<PlatformCredentialSummary>;
export async function listPlatformCredentialSummaries(database): Promise<PlatformCredentialSummary[]>;
export async function decryptPlatformCredential(database, config, id): Promise<string>;   // 给 Task 5
```

- protocol：

```ts
export interface PlatformCredentialSummary {
  id: string; provider: string; label: string; accountLogin: string; last4: string;
  expiresAt: string | null; probedAt: string | null;
  repoAccess: Array<{ repo: string; access: "read" | "write" }>;
}
```

- 路由（全部经 `requireOperator`）：`GET /admin/credentials` → `{ credentials }`；`POST /admin/credentials` body `{ label, token }` → 201；`PUT /admin/credentials/:id` body `{ label?, token? }`（给了 token 就重新探测）；`POST /admin/credentials/:id/probe`；`DELETE /admin/credentials/:id` → `{ ok: true }`。

- [ ] **Step 1: 写 schema + 生成迁移**，确认 `apps/controller/db/migrations/0029_*.sql` 含 `CREATE TABLE "platform_vcs_credentials"`。
- [ ] **Step 2: 写失败集成测试** `admin.integration.test.ts`（operator 用 `testConfig({ OPERATOR_GITHUB_LOGINS: "default-test-user" })`）：

```ts
it("refuses non-operators", ...)                                    // 默认 config → GET /admin/credentials 403
it("probes a saved token per private repository and records read or write", ...)
  // repos: A private push=false read 200/receive 403 → read；B private receive 200 → write；C public → 不出现
  // POST → 201；repoAccess 恰为 [{A,read},{B,write}]；last4 正确；accountLogin
it("never returns the token in list or detail responses", ...)
it("re-probes on demand and replaces the token on update", ...)      // PUT 新 token → accountLogin 变化
it("removes a credential", ...)
```

- [ ] **Step 3: 运行确认失败**
- [ ] **Step 4: 实现** db 层、服务、路由、挂载；`resetTables` 加表。
- [ ] **Step 5: 运行** → PASS；`pnpm test:integration` 全部 PASS
- [ ] **Step 6: Commit** `feat: platform credentials with per-repository access probing`

---

### Task 5: 仓库访问判定并接入仓库列表、创建任务、broker

**Files:**
- Create: `apps/controller/vcs/repository-access.ts`、`apps/controller/vcs/repository-access.integration.test.ts`
- Modify: `apps/controller/http/meta.ts`（`resolveRepos`、`repositoryIsSelectable`）、`apps/controller/http/manual.ts:58-75`、`apps/controller/secrets/broker.ts`（`createCredentialBroker(config, database, log, deps?: { fetchImpl?: typeof fetch })`、`mintForRepository` GitHub 分支、`mintForRun` 注入 `GIT_AUTHOR_*`）、`apps/controller/db/auth.ts`（加 `getAppUserById(database, id): Promise<AppUserRow | null>`）、`packages/protocol/api.ts`（`VcsRepository` 不改；`ReposResponse.repos` 元素加可选 `access?: "write" | "read"`——放在 `ReposResponse` 的 `repos: Array<VcsRepository & { access?: … }>`）、`apps/controller/index.ts`（若 broker 在此创建，传 `fetch`）

**Interfaces:**
- Consumes: Task 3 `getPersonalToken`；Task 4 `findPlatformCredentialsForRepo` + `decryptPlatformCredential`；Task 2 `probeGithubRepoAccess`、`listGithubTokenRepositories`；现有 `loadReviewRepositories` / `usableReviewRepository`、`getVcsAccessToken`。
- Produces:

```ts
export type RepositoryAccess =
  | { mode: "write"; source: "app-user-token" | "pat"; token: Secret }
  | { mode: "read";  source: "pat" | "platform-credential"; token: Secret }
  | { mode: "none";  reason: string };

export async function resolveRepositoryAccess(database, config, user: AppUserRow, repoFullName: string, need: "read" | "write", deps: { fetchImpl: typeof fetch }): Promise<RepositoryAccess>;
  // 顺序：1) 配置了 App 且 usableReviewRepository 命中 → 用 getVcsAccessToken(…,"github") 的用户 token，mode "write"
  //       2) getPersonalToken 存在 → probeGithubRepoAccess(pat)：need write 且 "write" → write/pat；need read 且 ≠ none → read/pat；
  //          探测抛 401/inspect 失败 → return none, reason "Your personal GitHub token was rejected. Update it in Settings."（不再继续）
  //       3) need read → findPlatformCredentialsForRepo 中 access === "read" 的优先，其次 "write" 不选（只读任务不用可写凭证）→ read/platform-credential
  //       4) none, reason "No credential can reach <repo>. Add a personal token in Settings, or ask an operator for read access."
export async function listWritableRepositories(database, config, user, deps): Promise<Array<VcsRepository & { access: "write" }>>;
  // = App 安装覆盖的仓库 ∪ PAT canPush 的仓库（按 fullName 去重、排序）；PAT 缺失或失效时只返回 App 部分
export function gitAuthorEnv(user: AppUserRow): Record<string, string>;  // 4 个 GIT_* 变量
```

- `meta.ts`：GitHub 的 `resolveRepos` 改用 `listWritableRepositories`；`requiresGithubInstallation` 删除；`repositoryIsSelectable` = `resolveRepositoryAccess(..., "read").mode !== "none"`。无用户时保持原行为（公共仓库）。
- `manual.ts`：GitHub + `requireUser` 时调 `resolveRepositoryAccess(..., "write")`，`none` → `throw new Error(reason)`（现有映射为 422）。
- `broker.ts`：GitHub 分支改为 `resolveRepositoryAccess(..., "write")` 失败则再试 `"read"`；`none` → 抛 reason。`mintForRun` 在 `env` 里 `Object.assign(env, gitAuthorEnv(user))`（`user` 由 `getAppUserById(run.userId)` 取）。`SCM_TOKEN_USERNAME` 仍为 `x-access-token`。

- [ ] **Step 1: 写失败集成测试** `repository-access.integration.test.ts`（直接调函数 + 通过 app 调 `/repos`、`POST /sessions`；fake fetch 用 `test-support-github.ts`）：

```ts
it("lists repositories the personal token can push to, without a GitHub App installation", ...)  // GET /repos → 含 food-truck/master-data-management，access "write"
it("lets a task start on a repository the personal token can write", ...)                      // POST /sessions 201
it("refuses to start when no credential can write the repository", ...)                        // 无 PAT → 422，error 含 "personal token"
it("fails loudly instead of falling back when the personal token is rejected", ...)             // PAT 存在但 fake 401 → none，reason 含 "rejected"；不会返回 platform-credential
it("prefers a read-only platform credential over a writable one for read access", ...)          // 两条凭证覆盖同一仓库 → source platform-credential 且 token 是只读那条
it("mints the personal token and the signed-in author for a run", ...)
  // createCredentialBroker(...).mintForRun → secrets.SCM_TOKEN.expose() === pat；env.GIT_AUTHOR_EMAIL === "default-test-user+default-test-user@users.noreply.github.com"
```

- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现** 判定函数、接入三处、`getAppUserById`。
- [ ] **Step 4: 运行** → PASS；`pnpm test:integration` 全部 PASS（`sessions.integration.test.ts`、`api.integration.test.ts` 若因 App 门槛假设而失败，按新规则调整它们的前置：这些测试用 `testCredentialBroker` 且 `APP_AUTH_REQUIRED=false`，预期无需改动）
- [ ] **Step 5: Commit** `feat: resolve repository credentials from personal token, platform credentials or GitHub App`

---

### Task 6: 前端：PAT 卡片、Admin › Credentials、引导文案

**Files:**
- Create: `apps/web/components/PersonalTokenCard.tsx`、`apps/web/app/admin/credentials/page.tsx`、`apps/web/components/PlatformCredentialCard.tsx`
- Modify: `apps/web/lib/api.ts`（`getPersonalToken`、`savePersonalToken(token)`、`deletePersonalToken`、`listPlatformCredentials`、`createPlatformCredential({label,token})`、`updatePlatformCredential(id,{label?,token?})`、`probePlatformCredential(id)`、`deletePlatformCredential(id)`）、`apps/web/app/settings/page.tsx`（GitHub 卡片下方插入 `<PersonalTokenCard />`；文案 "Your signed-in identity. Repository access is selected separately…" 改为 "Your signed-in identity. Add a personal access token to develop with your own identity."）、`apps/web/components/SideNav.tsx`（`isOperator` 时显示 "Admin" 分组：Credentials）、`apps/web/components/GithubOnboarding.tsx`（判定改为 `hasPat || 有 App 仓库` 则 ready；文案改成两条路径：开发 → Settings 加 token；产品 / 测试 → 联系管理员；去掉 `inert` 阻塞，改为页面顶部可关闭的卡片）

**Interfaces:**
- Consumes: Task 3、4 的 API 与类型。
- PAT 卡片状态（PRD §7.3）：`none`（输入框 + 创建引导，推荐 classic `repo` + `workflow`）/ `valid`（徽章、kind、last4、scopes、到期、可写仓库 N 个、更换 / 删除；到期 ≤ 14 天徽章变黄）/ `invalid`（红色，输入框）/ `pendingHint`（黄色提示"可能在等待组织审批，可改用 classic"）/ 保存 400 时在输入框下显示服务端 `error`。
- Admin 页：卡片列表（label、accountLogin、last4、到期、probedAt；按钮 重新探测 / 更换 / 删除；表格 仓库 → 只读 / 可写）；"添加 token" 展开表单（label + token）；非 operator 访问显示 403 文案。

- [ ] **Step 1: 加 api.ts 方法与类型导入**
- [ ] **Step 2: 实现 PersonalTokenCard 并接入 settings 页**
- [ ] **Step 3: 实现 Admin › Credentials 页与侧栏入口**
- [ ] **Step 4: 调整 GithubOnboarding**
- [ ] **Step 5: 验证** `pnpm typecheck && pnpm lint`；`pnpm controller` + `pnpm web` 手动走一遍：保存一个真实 classic PAT → 状态有效 → 新建任务下拉出现 `food-truck/master-data-management`（用 `OPERATOR_GITHUB_LOGINS=cato-wen` 看 Admin 页，录入 `ReadOnly` token → 权限表显示只读）
- [ ] **Step 6: Commit** `feat(web): personal token card and platform credential admin`

---

### Task 7: 文档与清理

**Files:**
- Modify: `docs/secrets.md`（§"Users never enter a PAT" 改写：凭证来源三种、PAT 的边界变化、平台凭证只读、git 作者）、`docs/operations.md`（管理员：录入平台凭证、`OPERATOR_GITHUB_LOGINS`、如何创建只读 fine-grained token）、`apps/controller/README.md`（文件表加 `auth/operator.ts`、`vcs/personal-token.ts`、`vcs/platform-credentials.ts`、`vcs/repository-access.ts`、`http/admin.ts`）、`packages/vcs/README.md`、`docs/testing.md`（覆盖表加三行新测试）、`.env.example`（`OPERATOR_GITHUB_LOGINS` 注释更新）、`docs/design/repository-access.md` §13 阶段 1 标记完成

- [ ] **Step 1: 更新上述文档**
- [ ] **Step 2: 运行** `pnpm verify` → 全部通过（`docs:check` 原有的 `.github/PULL_REQUEST_TEMPLATE.md` 两个坏链接若仍失败，顺手改成相对路径 `../CONTRIBUTING.md`、`../docs/secrets.md`）
- [ ] **Step 3: Commit** `docs: credential model for personal tokens and platform credentials`

## Self-review

- 规格覆盖：§4.1 PAT（Task 3）、§4.2 平台凭证 + 探测（Task 4）、§4.4 顺序 + git 作者（Task 5）、§12 PAT 保存时探测与提示（Task 3 `pendingHint`）、§13 阶段 1 的 `isOperator` 迁移（Task 1）、`meta.ts` / `manual.ts` / broker 接入（Task 5）、前端（Task 6）、文档（Task 7）。§4.3 的 App 用户 token 在 Task 5 第 1 步使用现有 `getVcsAccessToken`。
- 类型一致：`PersonalTokenStatus`、`PlatformCredentialSummary`、`RepositoryAccess`、`GithubTokenDeps` 在各任务间同名。`fetchImpl` 统一经 `Deps.fetchImpl` → `c.get("fetchImpl")` → 服务 `deps`。
- Review Focus 五条分别由 Task 3（1、4、5）、Task 5（2、3）、Task 4（3、4）的测试覆盖。
