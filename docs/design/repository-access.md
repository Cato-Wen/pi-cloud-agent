# 设计：仓库访问、内置 Agent 与 Skill（v2）

状态：草案 v2，待确认 · 2026-11-05
上一版（v1，只有 PAT + 只读授权）已被本版取代。

## 1. 背景与目标

现在 GitHub 仓库访问完全依赖 GitHub App 安装，而 `food-truck` 组织审批安装 App 的周期很长。同时，产品和测试的使用方式和开发不同：他们不关心"选哪个仓库"，关心的是"用代码 + 需求文档（+ 测试用例）完成一个任务"，这些内容分散在不同仓库里。

目标：

1. **有 GitHub 账号的人都能登录。** 登录只确认身份，不再要求安装 App。
2. **开发**：和现在一样选一个仓库做需求开发，用本人 PAT，commit 和 PR 都是本人。另外可以把需求仓库（如 `team-cookbook-feature`、`team-cookbook-kb`）作为**上下文仓库**一起 clone 进沙箱（只读）。
3. **产品 / 测试**：不选仓库，选**平台内置的 agent**。agent 由管理员定义：名字、提示词、能访问哪些仓库（每个仓库只读或读写）、带哪些 skill。管理员把 agent 分配给人；用户登录后能看到分配给自己的 agent，并在其中一个 agent 下执行任务。
4. **个人定制**：拥有某个 agent 的人可以改它的提示词、增删它的 skill，只对自己生效。
5. **Skill**：用户除了平台下发的 skill，还可以创建自己的 skill（新增 / 修改 / 删除），只有自己可见。
6. **`/` 快捷命令**：在对话框输入 `/` 能调用 skill 和提示词模板（Pi 原生机制）。

不在本次范围内：

- 用户自己创建 agent（表结构按可扩展设计，见 §5.3）；
- 平台内的"申请 agent / 申请权限"流程（第一版线下找管理员）；
- 登录白名单（可以以后加）；
- 自动 PR review 集成（仍依赖 GitHub App 安装，行为不变）；
- 共享读写 token 代替开发提交代码（开发一律用本人 PAT）。

## 2. 已确认的事实

### 2.1 代码现状

| 环节 | 位置 | 现状 |
|---|---|---|
| 登录 | `apps/controller/http/auth.ts`、`vcs/connections.ts` | GitHub App 用户 OAuth，token 存 `vcs_connections`（provider=`github`） |
| 仓库列表 / 创建任务校验 | `http/meta.ts`、`http/manual.ts` | 配置了 `GITHUB_APP_ID` 时只允许 App 安装覆盖的仓库 |
| 运行凭证 | `secrets/broker.ts` | 用 App 私钥换单仓库 installation token，注入 `SCM_TOKEN` / `GITHUB_TOKEN` / `GH_TOKEN` |
| 工作区 | `sessions.repo`、`runs.repo_full_name`、`packages/runtime/workspace.ts` | **一个 session 只有一个仓库**，clone 到 `/workspace/<repoName>`；git credential helper 只支持一个 token |
| git 作者 | runtime | 没有设置 |
| 插件 / skill | `packages/plugins`、`apps/controller/plugins` | 插件 = marketplace 包（skill + MCP）。skill 文本在**第一轮**被拼到 `TASK_PROMPT` 前面；不是 Pi 原生 skill |
| Pi 的 `/` 命令 | `pi-coding-agent@0.82.1` `agent-session.js:792` | `session.prompt(text)` 会处理：extension 命令、`/skill:<name> args`（展开 SKILL.md）、`/<template> args`（`prompts/` 下的模板，支持 `$1`、`$ARGUMENTS`）。**`/compact`、`/model`、`/new` 等内置命令只在 TUI 里有效**，`session.prompt` 不处理 |
| Pi skill 发现 | `skills.js:291` | 从 `<agentDir>/skills/**/SKILL.md` 和 cwd 的 `.pi/skills` 加载，并以列表形式写进 system prompt |
| operator | `OPERATOR_GITHUB_LOGINS` 环境变量，`plugins/marketplace.ts:427` `isOperator` | 继续沿用；`isOperator` 挪到 auth 模块 |

### 2.2 GitHub 组织现状（2026-11-05 用 `Cato-Wen` 账号实测）

| 事项 | 结果 |
|---|---|
| food-truck | enterprise 计划；`Cato-Wen` 是 member，对 `master-data-management` 有写权限 |
| food-truck 的 fine-grained PAT | **需要组织审批**（生成后 Pending）。已有一个审批通过的只读 token `ReadOnly`（Contents 等全部 Read，仅 `master-data-management`，到期 2027-09-17；regenerate 后默认有效期变 30 天，要手动选最长） |
| ct-kb | 38 个私有仓库；`Cato-Wen` 是 **admin**，所以 ct-kb 的 PAT 不需要别人审批，也可以直接给 ct-kb 安装 GitHub App |
| fine-grained PAT 的范围 | 一个 token 只能有一个 Resource owner。要访问两个组织就要两个 token |
| 只读判定 | REST 的 `permissions.push` 反映的是**账号**权限，不是 token 权限。判断 token 能否写要探测 `GET https://github.com/{repo}.git/info/refs?service=git-receive-pack`（有写权限 200，无写权限 403）。已验证 |
| classic PAT | **可用，不需要审批**（2026-11-05 实测：`repo` + `workflow` scope 的 classic PAT 对 `master-data-management` clone 200、push 200）。缺点是范围覆盖本人所有组织的所有仓库（实测可见 100+ 个），所以沙箱内泄漏的影响面比 fine-grained 大 |

## 3. 整体模型

```
                登录：GitHub App OAuth → app_users（不变，只确认身份）

  凭证层        个人 PAT（开发）                 平台凭证（管理员录入，每个 token 一行，
                vcs_connections                  自动探测出它对每个仓库是只读还是读写）
                provider='github-pat'            platform_vcs_credentials

  能力层        开发模式                          agent 模式
                主仓库（写，本人 PAT）             agents：名字 / 团队 / 提示词 / 仓库列表(读|写) / skill
                + 上下文仓库（只读，平台凭证）      agent_assignments：分配给谁
                                                 user_agent_overrides：个人改提示词、增删 skill

  skill         skills：平台 skill（operator 发布）+ 个人 skill（只有自己可见）
                运行时写成 <agentDir>/skills/<name>/SKILL.md，走 Pi 原生 skill 和 /skill:<name>

  运行          session/run 记录 workspace_repos: [{repo, access, role}]
                runtime 逐个 clone 到 /workspace/<name>，credential helper 按仓库选 token
                GIT_AUTHOR_* = 登录人
```

**新建任务页只有一个下拉框**，里面分两组：**Agents**（分配给我的 agent）和 **Repositories**（我的 PAT 能写的仓库）。选 agent 进入 agent 模式，选仓库进入开发模式。一个 session 创建后模式和 agent 固定不变。

## 4. 凭证

### 4.1 个人 PAT（开发）

复用 `vcs_connections`，新增一行 `provider = 'github-pat'`：

| 字段 | 值 |
|---|---|
| `account_id` | token 所属 GitHub user id，**必须等于** `app_users.github_user_id`（防止冒用别人身份提交） |
| `account_name` | GitHub login |
| `access_token` | `encryptSecret` 加密 |
| `refresh_token` | NULL |
| `expires_at` | 响应头 `GitHub-Authentication-Token-Expiration`；没有则 NULL |

保存时校验：`GET /user` 成功且 id 匹配；读出过期时间和（classic 才有的）scopes；classic 没有 `repo` scope 时拒绝。过期后 `getVcsAccessToken` 会抛 "needs to be reconnected"，正好得到明确报错。

### 4.2 平台凭证：`platform_vcs_credentials`

管理员录入的 token，每个 token 一行。**不再预设"只读 / 读写"用途**，而是录入时自动探测它对每个可见仓库的实际能力：

```sql
CREATE TABLE platform_vcs_credentials (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider       text NOT NULL,                 -- 'github'
  label          text NOT NULL,                 -- 管理员起的名字，如 'food-truck 只读'
  account_id     text NOT NULL,                 -- token 所属账号
  account_login  text NOT NULL,
  access_token   text NOT NULL,                 -- 加密
  expires_at     timestamptz,
  repo_access    jsonb NOT NULL DEFAULT '[]',   -- [{ repo, access: 'read'|'write' }]，探测结果
  probed_at      timestamptz,
  updated_by     uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
```

探测流程（录入时执行，后台也可手动"重新探测"）：

1. `GET /user` 取所属账号和过期时间；
2. `GET /user/repos?per_page=100` 分页，**只保留私有仓库**（fine-grained PAT 默认能看到所有公开仓库，会混进大量无关项）；
3. 对每个仓库请求 `info/refs?service=git-upload-pack`（能读 → 200）和 `service=git-receive-pack`（能写 → 200，否则 403）。写入 `repo_access`。

同一个仓库被多个凭证覆盖时，运行时按需要的权限选：需要 `write` 选能写的，需要 `read` 优先选只读凭证（最小权限）。

**计划录入的凭证**：

| label | 来源 | 覆盖 |
|---|---|---|
| food-truck 只读 | 已审批的 `ReadOnly` token（regenerate 时选 366 天） | `food-truck/master-data-management` read |

ct-kb **不建平台写凭证**：把 GitHub App 装到 ct-kb（`Cato-Wen` 是 admin，自己就能装），用户用自己的登录 token 写（见 §4.3）。后续换成专用机器账号时，在后台替换 token 即可，不改代码。

### 4.3 GitHub App 的两种 token

| token | 身份 | 用途 |
|---|---|---|
| installation token（App 私钥换的，现在 `broker.ts` 用的） | `pi-cloud-agent[bot]` | 保留给自动 review / 评论等平台动作 |
| **user-to-server token**（登录 OAuth 拿到的，存在 `vcs_connections` provider=`github`） | **登录人本人** | 能访问"App 已安装的组织里、本人有权限的仓库"。8 小时过期，带 refresh token，`getVcsAccessToken` 已自动刷新 |

App 装到 ct-kb 后，产品 / 测试用自己的登录 token 读写 ct-kb 仓库，commit、push、PR 都是本人，不用配任何 token。前提是本人在对应 ct-kb 仓库上有写权限（admin 可以加）。

### 4.4 运行时凭证签发（`secrets/broker.ts`）

`mintForRun` 不再只签一个 token，而是对 `workspace_repos` 里每个仓库**按顺序**选：

| 顺序 | 条件 | 凭证 | 身份 |
|---|---|---|---|
| 1 | 仓库所在组织装了 App，且本人对仓库有所需权限 | 本人登录 token | 本人 |
| 2 | 本人绑定了 PAT，且 PAT 有所需权限 | 本人 PAT | 本人 |
| 3 | 需要的是 read，且平台凭证 `repo_access` 覆盖 | 平台只读凭证 | 只读，不提交 |
| 4 | 都没有 | 创建任务时拒绝，说明缺哪个仓库的权限 | — |

开发模式主仓库要求 write，PAT 失效 → 任务失败并提示更新，**不退回**其他凭证。agent 配置为 read 的仓库，即使所选 token 有写权限，runtime 也禁掉 push 地址（§7.2）。

对应到当前场景：

| 仓库 | 产品 / 测试 | 开发 |
|---|---|---|
| `ct-kb/team-cookbook-kb` 等 | 顺序 1，本人登录 token | 同左 |
| `food-truck/master-data-management` | 顺序 3，平台只读 token | 顺序 2，本人 PAT |

注入方式：`SCM_TOKEN_0..n` + `SCM_REPOS`（JSON：`[{ path: "github.com/ct-kb/team-cookbook-kb", tokenVar: "SCM_TOKEN_1", username }]`）。`GITHUB_TOKEN` / `GH_TOKEN` 设为主仓库（开发模式）或第一个可写仓库（agent 模式）的 token，供 `gh` 使用。

git 作者一律注入登录人：

```
GIT_AUTHOR_NAME / GIT_COMMITTER_NAME   = app_users.login
GIT_AUTHOR_EMAIL / GIT_COMMITTER_EMAIL = <github_user_id>+<login>@users.noreply.github.com
```

GitHub 按 noreply 邮箱把 commit 关联到本人。agent 模式下 push 的人是平台凭证的账号（`Cato-Wen` 或机器账号），commit 作者仍是本人。

**安全边界变化**（写进 `docs/secrets.md`）：现在注入沙箱的是单仓库、1 小时过期的 installation token；改造后是 PAT（范围由创建者决定）或平台凭证（覆盖多个仓库、有效期长达一年）。沙箱内恶意代码在任务运行期间可以窃取这些 token。缓解：fine-grained PAT 只勾必要仓库；平台凭证按 agent 需要拆分，不要一个 token 覆盖所有组织；后续用 controller 侧 git 凭证代理把 token 挡在沙箱外（`docs/secrets.md` 已列为下一步）。

## 5. Agent

### 5.1 表

```sql
CREATE TABLE agents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL UNIQUE,            -- 'cookbook-pm'
  name          text NOT NULL,                   -- 'cookbook-PM-agent'
  team          text NOT NULL,                   -- 'cookbook' / 'consumer'，分组展示用
  description   text NOT NULL DEFAULT '',
  system_prompt text NOT NULL,                   -- 基础提示词
  repos         jsonb NOT NULL DEFAULT '[]',     -- [{ provider, repo, access: 'read'|'write' }]
  owner_user_id uuid REFERENCES app_users(id) ON DELETE CASCADE,  -- NULL = 平台 agent（预留给用户自建）
  created_by    uuid REFERENCES app_users(id) ON DELETE SET NULL,
  archived_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_skills (                       -- agent 默认带的平台 skill
  agent_id  uuid REFERENCES agents(id) ON DELETE CASCADE,
  skill_id  uuid REFERENCES skills(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, skill_id)
);

CREATE TABLE agent_assignments (                  -- 分配给谁
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  github_user_id  text NOT NULL,                  -- 按 id 匹配，不要求对方登录过
  github_login    text NOT NULL,                  -- 展示用
  granted_by      uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, github_user_id)
);

CREATE TABLE user_agent_overrides (               -- 个人定制，只对自己生效
  user_id         uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  agent_id        uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  system_prompt   text,                           -- NULL = 用 agent 默认
  skills_added    uuid[] NOT NULL DEFAULT '{}',   -- 可以是平台 skill 或自己的 skill
  skills_removed  uuid[] NOT NULL DEFAULT '{}',   -- 从 agent 默认里去掉的
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, agent_id)
);
```

管理员录入 agent 的仓库时，下拉框只列出 `platform_vcs_credentials.repo_access` 里有的仓库，并显示每个仓库最高能给到什么权限。保存时校验所选权限不超过凭证能力。

示例配置（管理员可随时改）：

| agent | 仓库 |
|---|---|
| cookbook-PM-agent | master-data-management（只读）、team-cookbook-feature（读写）、team-cookbook-kb（读写） |
| cookbook-testing-agent | master-data-management（只读）、team-cookbook-feature（只读）、team-cookbook-kb（只读）、cookbook-test-cases（读写） |
| consumer-PM-agent / consumer-testing-agent | 同样模式 |

### 5.2 解析一次运行的有效配置

`resolveAgentForRun(user, agentId)`：

1. 校验 `agent_assignments` 里有 `(agent, user.github_user_id)`，否则 403；
2. `system_prompt` = override 有值则用 override，否则用 agent 的；
3. skills = (agent_skills − skills_removed) ∪ skills_added，其中个人 skill 必须属于本人；
4. repos = agent.repos，每个仓库按 §4.3 选凭证；
5. 把解析结果快照进 `runs.agent_snapshot`（jsonb），便于审计"这次任务到底用了什么"。

agent 定义改了之后：新 session 用新配置；已有 session 的下一轮也用新配置（仓库变化时 runtime 补 clone 新增的、不再给被移除仓库的凭证）。

### 5.3 可扩展：用户自建 agent

`agents.owner_user_id` 非空即个人 agent：只对本人可见，不需要 assignment，仓库只能选本人 PAT 能访问的。第一版不开放入口，表结构已经兼容。

## 6. Skill

```sql
CREATE TABLE skills (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id  uuid REFERENCES app_users(id) ON DELETE CASCADE,  -- NULL = 平台 skill
  kind           text NOT NULL DEFAULT 'skill',  -- 'skill' | 'prompt'（提示词模板）
  name           text NOT NULL,                  -- 也是 /<name> 的名字；^[a-z0-9-]+$
  description    text NOT NULL DEFAULT '',
  content        text NOT NULL,                  -- SKILL.md 正文（或模板正文）
  enabled        boolean NOT NULL DEFAULT true,  -- 平台 skill 的启用开关
  plugin_name    text,                           -- 非空 = 来自插件包，内容只读
  created_by     uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, name)                   -- 个人 skill 名字可以和平台的同名，运行时个人优先
);
```

- **平台 skill**：operator 创建、编辑、启停；通过 `agent_skills` 挂到 agent。没有"全局"概念（PRD 评审已定）：想让所有 agent 都带，就逐个加进默认 skill。
- **插件 skill**：context7、exa 等插件自带的 skill 也出现在管理后台的 skill 列表里（来源标"插件"），可启停、可挂到 agent，内容来自插件包、只读。实现上 `skills` 表加 `plugin_name` 列，seed / publish 插件时同步写入。
- **个人 skill**：任何用户在 Settings → Skills 里增删改；只有自己可见；可以加到自己拥有的任何 agent（override），开发模式下自动带上。
- **运行时落盘**：controller 把本次有效的 skill 列表交给沙箱（见 §8），runtime 在创建 Pi session 前写成 `<agentDir>/skills/<name>/SKILL.md`（frontmatter: name、description），`kind='prompt'` 的写到 `<agentDir>/prompts/<name>.md`。然后 `DefaultResourceLoader` 原生加载，Pi 会把 skill 清单写入 system prompt，模型按需读取；用户也能用 `/skill:<name>` 显式触发。
- 内容大小：单个 skill 上限 64 KB；总量通过 controller 的 internal API（`GET /internal/runs/:id/resources`，用 callback token）拉取，不走环境变量，避免长度限制。

**与现有插件的关系**：插件的 skill 现在是拼进第一轮 prompt 的文本。本次把插件的 skill 也改为同样落盘到 `<agentDir>/skills/`（`packages/plugins/skills.ts` 已经按 `skills/*/SKILL.md` 发现），`composeSkillText` 退役。MCP 部分不变。这样所有 skill 走一条路径，`/skill:` 也对插件 skill 生效。

## 7. 工作区：多仓库

### 7.1 数据

`sessions` 和 `runs` 新增 `workspace_repos jsonb NOT NULL`：

```ts
type WorkspaceRepo = {
  provider: "github";
  repo: string;              // 'ct-kb/team-cookbook-kb'
  access: "read" | "write";
  role: "primary" | "context"; // primary 只在开发模式有，决定 cwd 和 diff 侧栏
  ref: RepoRef;              // 现有结构：cloneUrl、defaultBranch、headBranch…
};
```

`sessions.repo_full_name` / `runs.repo_full_name` 改为可空（agent 模式为 NULL）；`sessions.repo` 保留为 primary 的 `RepoRef`，agent 模式为 NULL。现有读取这两个字段的地方（session 列表、标题、diff 侧栏）要兼容 NULL。

新增 `sessions.agent_id`、`runs.agent_id`（可空）、`runs.agent_snapshot jsonb`。

### 7.2 runtime（`packages/runtime/workspace.ts`）

- `prepareCheckout` 改为遍历 `workspace_repos`，每个 clone 到 `/workspace/<repoName>`（同名冲突时用 `<owner>__<name>`）。shallow clone 不变。resume 时对缺失的仓库补 clone。
- **cwd**：开发模式 = primary 仓库目录；agent 模式 = `/workspace`。
- **credential helper**：改为从 stdin 读 git 传来的 `host` 和 `path`，在 `SCM_REPOS` 里匹配，输出对应 `SCM_TOKEN_n`。`credential.useHttpPath=true`。没匹配到的仓库不输出凭证（于是 push 到未授权仓库会失败）。
- **只读仓库的额外保险**：对 `access='read'` 的仓库执行 `git remote set-url --push origin DISABLED`，让 agent 即使拿错 token 也推不出去；提示词里也写明哪些仓库只读。
- **diff 侧栏**（`gitDiff`）：开发模式只看 primary；agent 模式对每个 `write` 仓库各算一份，前端分 tab 显示。

### 7.3 提示词

controller 在任务提示词前拼一段工作区说明（每轮都拼，不只第一轮；替换现在只在第一轮拼 skill 文本的做法）：

```
工作区：
- /workspace/master-data-management  food-truck/master-data-management  只读（代码）
- /workspace/team-cookbook-kb        ct-kb/team-cookbook-kb             可写（当前分支 main）
只读仓库不要 commit / push。可写仓库的改动请 commit 后 push 到当前分支。
```

agent 模式：`system_prompt`（agent 或个人 override）作为 Pi 的 `appendSystemPrompt`，不是拼在用户消息里。

### 7.4 开发模式的上下文仓库

新建任务页在选了主仓库后，出现"上下文仓库（只读）"多选：候选 = 本人登录 token 与 PAT 能读的仓库，去掉主仓库。平台凭证不在此列：沙箱属于选仓库的人，平台凭证只通过阶段 3 的 agent 分配借出。创建 session 时一起写入 `workspace_repos`，沙箱启动时一起 clone。

## 8. 运行时资源下发

现在 skill 文本和 MCP 配置走环境变量。改为 runtime 启动后用 callback token 调一次 `GET /internal/runs/:runId/resources`，返回：

```ts
{
  skills:  Array<{ name, description, content }>,
  prompts: Array<{ name, content }>,
  mcpConfig: McpConfigFile | null,     // 现有
  workspace: WorkspaceRepo[],          // 不含 token
  systemPrompt: string | null,         // agent 模式
}
```

token 仍走环境变量（`Secret`，不入日志）。

## 9. `/` 快捷命令

**能做什么**：`session.prompt(text)` 原生支持 `/skill:<name> [args]` 和 `/<template> [args]`，所以：

- 对话框输入 `/` 弹出候选：本次 session 可用的 skill 和提示词模板（agent 默认 + 个人 + 全局），来自 `GET /sessions/:id/commands`（新 session 页用 `GET /commands?agent=…` 或 `?repo=…`）；
- 用户选 `/foo bar` 发送；controller 原样存为用户消息，下发给沙箱前把 skill 类的 `/foo` 改写成 `/skill:foo`（模板类保持 `/foo`），runtime `session.prompt` 展开。

**不能做什么**：Pi 的 `/compact`、`/model`、`/new`、`/export` 等是 TUI 内置命令，`session.prompt` 不处理。其中：

- `/model`、思考等级：页面上已有选择器，不需要命令；
- `/new`：对应"新建任务"；
- `/compact`：需要验证 `AgentSession` 是否暴露了 `compact()`，有就映射成平台命令，没有就不做。

候选列表用现有的 `ai-elements/prompt-input` 组件加一个 `/` 触发的下拉（`ChatComposer.tsx`）。

## 10. API

都挂在现有 controller 下，需要登录；`/admin/*` 还需 operator。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET/PUT/DELETE` | `/vcs/github/pat` | 个人 PAT |
| `GET` | `/repos` | 改：返回 `{ repos: [{..., access}], agents: [{ id, name, team, description }] }`，给新建任务页的下拉框 |
| `GET` | `/repos/context?primary=…` | 上下文仓库候选 |
| `POST` | `/sessions` | 改：body 二选一 `{ repo, contextRepos[] }` 或 `{ agentId }` |
| `GET` | `/agents/mine` | 分配给我的 agent（含 override 后的有效配置） |
| `GET/PUT` | `/agents/:id/override` | 我的定制：提示词、skills_added、skills_removed |
| `GET/POST/PUT/DELETE` | `/skills` | 个人 skill CRUD（只看得到自己的 + 平台已启用的只读视图） |
| `GET` | `/commands?agent=…\|repo=…`、`/sessions/:id/commands` | `/` 候选 |
| `GET/POST/PUT/DELETE` | `/admin/credentials`，`POST /admin/credentials/:id/probe` | 平台凭证 |
| `GET/POST/PUT/DELETE` | `/admin/agents` | agent CRUD（含仓库、默认 skill） |
| `GET/POST/DELETE` | `/admin/agents/:id/assignments` | 分配 / 撤销；body `{ logins: string[] }`，controller 用平台凭证 `GET /users/{login}` 换 id |
| `GET/POST/PUT/DELETE` | `/admin/skills` | 平台 skill |
| `GET` | `/auth/me` | 加 `hasPat`、`agentCount` |

## 11. 前端

| 页面 | 内容 |
|---|---|
| 新建任务（`app/chat/page.tsx`） | 一个下拉框，两组：**Agents**、**Repositories**。选仓库后出现分支选择，工具栏最右多一个"上下文仓库 (n)"按钮；选 agent 后显示树状工作区卡片（agent → 仓库 / Skill）。对话框支持 `/` 候选 |
| Session 页 | 标题栏：agent 徽章（可点开看生效的仓库 / skill / 提示词）或主仓库 + 分支；工作区栏每仓库一个 chip + 权限徽章，身份信息收进 `!` 提示；diff 侧栏树状（仓库 → 文件，只读仓库折叠）；对话框 `/` 候选 |
| Settings → GitHub account | Tab：账号 / 我的 agent / Skill / 仓库（现有 App 安装页）。PAT 卡片：保存 / 状态（有效、等待审批、失效、不属于本人）/ 删除 / 创建引导 |
| Settings → My agents | 分配给我的 agent 列表；点开可改提示词（显示默认值、可"恢复默认"）、勾选 / 取消 skill |
| Settings → Skills | 个人 skill 列表，Markdown 编辑器，新增 / 修改 / 删除；平台 skill 只读展示 |
| Admin → Credentials | 标题旁 `!` 说明"每个没装 App 的组织一个 token"；凭证卡片：录入 / 替换 / 重新探测 / 删除，仓库权限表一列"只读 / 可写"；App 已安装的组织以状态卡显示，不存 token |
| Admin → Agents | agent 列表（按 team 分组）；编辑名字、团队、提示词、仓库和权限（只能选凭证覆盖的）、默认 skill；分配给 login（多选 / 粘贴多个） |
| Admin → Skills | 平台 skill CRUD、启停 |
| 首次登录引导（`GithubOnboarding.tsx`） | 没有 PAT 也没有 agent → 提示"开发：绑定 PAT；产品 / 测试：联系管理员分配 agent"。不阻塞 |

## 12. 安全与审计

| 风险 | 措施 |
|---|---|
| 用别人的 PAT 冒充提交 | 保存时校验 token id = 登录人 id |
| 平台凭证权限比预期大 | 录入时逐仓库探测；agent 仓库权限不能超过凭证能力；只读仓库禁用 push URL |
| token 泄漏到日志 | 一律 `Secret`；API 只回末 4 位 |
| 共享写凭证的追责 | commit 作者 = 本人（noreply 邮箱）；`runs.agent_snapshot` 记录用了哪个凭证、哪些仓库 |
| 配置变更追踪 | agent / assignment / credential 变更写 controller 日志（谁、改了什么） |
| 任何人都能登录 | 登录不授予任何仓库；后续可加白名单 |

classic PAT 已验证可用且不需要审批（§2.2）。Settings 引导顺序：**推荐 classic PAT**（勾 `repo` + `workflow`，立即可用）；fine-grained 作为"范围更小但要等组织审批"的选项。保存 PAT 时仍探测本人有写权限的仓库（`GET /repos/{repo}`）：fine-grained 返回 403/404 → 提示"可能在等待组织审批"。

## 13. 改动清单（按阶段）

### 阶段 1：凭证基础 ✅（分支 `feat/repository-access-phase-1`，2026-11-05）
`vcs_connections` PAT 行、`platform_vcs_credentials` + 探测；`packages/vcs/github-token.ts`（`inspectGithubToken`、`listGithubTokenRepositories`、`probeGithubRepoAccess`）；`/vcs/github/pat`、`/admin/credentials`；Settings PAT 卡片、Admin Credentials 页；`isOperator` 挪到 `auth/operator.ts`；`vcs/repository-access.ts` 统一判定并接入 `meta.ts`、`manual.ts`、broker（含 `GIT_AUTHOR_*`）。实施计划：`docs/superpowers/plans/2026-11-05-phase1-credentials.md`。
完成后开发不用等 App 审批。

### 阶段 2：多仓库工作区 ✅（同一分支，2026-11-06）
`WorkspaceRepo` / `SandboxWorkspaceRepo`、`planWorkspace`、`describeWorkspace`（`packages/protocol`）；`sessions.workspace_repos`、`trigger.contextRepos`、`POST /sessions` 与 `/runs` 的 `contextRepos`、`GET /repos/context`；broker 逐仓库签发 `SCM_TOKEN_<n>`、`WORKSPACE_REPOS`、每轮前置的工作区说明；runtime 多 clone、按仓库选 token 的 credential helper 脚本、只读仓库禁 push、恢复时补 clone；新建任务页上下文仓库按钮、会话页只读列表；diff 侧栏仍只看主仓库。`repo_full_name` 可空与 `agent_id` 留到阶段 3。实施计划：`docs/superpowers/plans/2026-11-06-phase2-workspace.md`。

### 阶段 3：Agent
`agents` / `agent_skills` / `agent_assignments` / `user_agent_overrides`；`resolveAgentForRun`；`/admin/agents`、`/agents/mine`、override；新建任务页下拉框合并 agent + 仓库；Session 页模式展示；Settings → My agents。
完成后产品 / 测试可以用。

### 阶段 4：Skill 与 `/` 命令
`skills` 表、平台 / 个人 skill API 与页面；runtime 资源拉取与落盘；插件 skill 改走同一路径；`/` 候选与改写；`/compact` 可行性验证。

### 阶段 5：收尾
`docs/secrets.md`、`docs/operations.md`（管理员手册）、`apps/controller/README.md`、`packages/vcs/README.md`、`packages/runtime/README.md`；审计日志；清理 App 安装引导；手动验证。

每阶段一个 PR，`pnpm verify` 通过后合入。

## 14. 测试要点

- `packages/vcs`：token 检查头解析；分页；receive-pack 探测的 200/403 判定。
- controller 单元：凭证选择（写优先 PAT；读优先只读凭证；无凭证拒绝）；`resolveAgentForRun`（未分配 403、override 合并、个人 skill 归属校验）。
- controller 集成：PAT 保存校验；admin 403；凭证探测结果写入；agent CRUD 与仓库权限不超凭证；创建 session 两种 body；`/commands` 返回集合。
- runtime：多仓库 clone 与 resume 补 clone；credential helper 按 path 选 token；只读仓库 push 失败；skill 落盘后 `/skill:<name>` 展开。
- 手动：开发绑定 PAT 跑任务 → commit / PR 是本人；PM agent 跑任务 → 能读代码、能改 kb 仓库、改不了代码仓库；`/` 候选和展开。

## 15. 已定与待确认

已定（2026-11-05）：
- 只读 token 第一版用 `Cato-Wen` 的 fine-grained PAT（已审批的 `ReadOnly`），后续可换机器账号；
- 不需要安全 / 合规审批；
- GitHub App 安装路径保留；**把 App 装到 ct-kb**，ct-kb 仓库用本人登录 token 读写（§4.3）；
- operator 继续用 `OPERATOR_GITHUB_LOGINS`，`isOperator` 挪到 auth 模块；
- 新建任务页一个下拉框同时列 agent 和仓库；
- agent 对 kb / feature / test-cases 仓库直接 commit 并 push 到 `main`；
- `/` 命令范围 = skill + 提示词模板（`/compact` 待验证可行性）；
- 插件 skill 改走 Pi 原生 skill 路径；
- 不单独验证 classic PAT，保存 PAT 时探测并提示（§12）。

上线前的手工步骤（管理员）：
1. 在 ct-kb 安装 pi-cloud-agent GitHub App，勾选 agent 会用到的仓库；
2. 确认每个产品 / 测试在自己团队的 ct-kb 仓库上有 write 权限；
3. regenerate `ReadOnly` token（有效期选 366 天），录入 Admin → Credentials；
4. 配置 `OPERATOR_GITHUB_LOGINS`。
