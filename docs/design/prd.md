# PRD：仓库访问、内置 Agent 与 Skill

状态：草案 v1 · 2026-11-05
配套：技术设计 [repository-access.md](repository-access.md) · 可点击原型 [prd-prototype.html](prd-prototype.html)（浏览器直接打开，顶部可按角色切换使用路径）

---

## 1. 一句话

让有 GitHub 账号的人都能登录 zen8agent；开发用自己的身份改代码，产品和测试通过管理员配置好的 **agent** 读代码、写需求和用例，不需要理解仓库和权限。

## 2. 背景

- 现在使用平台必须把 GitHub App 安装到 `food-truck` 组织，审批周期很长，团队被卡住。
- 产品和测试没有代码权限，但他们的任务（写 PRD、对照代码核对需求、写测试用例）需要同时看代码、需求文档和用例，这些分散在 `food-truck` 和 `ct-kb` 两个组织的多个仓库里。
- 现有产品一次只能操作一个仓库，也没有"按角色预设好一组仓库和提示词"的概念。

## 3. 角色

| 角色 | 代表 | 有没有代码权限 | 主要诉求 |
|---|---|---|---|
| **开发** | Cato-Wen | 有（`master-data-management` 写） | 选仓库做需求，commit / PR 是自己；顺便能看到需求文档 |
| **产品** | lisazheng-xm | 无代码权限；对团队 kb / feature 仓库有写 | 不选仓库，直接让 agent 读代码 + 需求，产出 PRD 写回 kb |
| **测试** | jennyz510 | 无代码权限；对 test-cases 仓库有写 | 让 agent 读代码 + 需求 + kb，产出测试用例写回 test-cases |
| **管理员**（operator） | Cato-Wen | — | 录入平台凭证、定义 agent、分配给人、维护平台 skill |

管理员由环境变量 `OPERATOR_GITHUB_LOGINS` 指定。一个人可以同时是开发和管理员。

## 4. 目标与非目标

**目标**

1. 有 GitHub 账号的人都能登录；登录不授予任何仓库权限。
2. 开发：绑定个人 token 后，以本人身份 clone / commit / push / 开 PR；可把需求仓库作为只读上下文一起带进沙箱。
3. 产品 / 测试：登录后看到管理员分配的 agent，选一个 agent 直接开始任务；agent 的仓库、权限、提示词、skill 由管理员定义。
4. 拥有 agent 的人可以改它的提示词、增删 skill，只对自己生效。
5. 每个人可以创建自己的 skill（私有），也能用平台下发的 skill。
6. 对话框输入 `/` 可以调用 skill 和提示词模板。

**非目标（本期不做）**

- 用户自建 agent（数据结构预留）；
- 平台内的权限申请 / 审批流（线下找管理员）；
- 登录白名单；
- 自动 PR review 的改动（继续走 GitHub App）；
- 用共享账号替开发提交代码。

## 5. 核心概念

| 概念 | 说明 |
|---|---|
| **个人 token（PAT）** | 开发在 Settings 绑定的 GitHub token，只用于本人；平台校验 token 必须属于当前登录账号 |
| **平台凭证** | 管理员录入的 token，平台替 agent 使用；录入时逐仓库探测"能读 / 能写" |
| **Agent** | 管理员定义的工作预设：名字、团队、描述、基础提示词、仓库清单（每个仓库 read 或 write）、默认 skill |
| **分配** | 管理员把 agent 给某个 GitHub 账号；被分配的人在新建任务时能选到它 |
| **个人定制** | 被分配者对 agent 的提示词覆盖 + skill 增删，只影响自己 |
| **Skill** | 一段 Markdown 指令。平台 skill 由管理员发布；个人 skill 私有。均可用 `/<name>` 触发 |
| **工作区** | 一次任务里沙箱内的所有仓库。开发模式 = 主仓库（写）+ 上下文仓库（只读）；agent 模式 = agent 定义的仓库 |

## 6. 用户故事与使用路径

### 6.1 开发

> 作为开发，我想用自己的身份改代码，并且在同一个任务里能看到需求文档。

1. 首次登录，看到引导（原型 ①首次登录）→ 点 "Add token in Settings"。
2. Settings › Account 绑定 PAT（原型 Settings · GitHub account）。按引导创建 classic token（`repo` + `workflow`），粘贴保存。页面显示有效期、scope、能写哪些仓库。
3. New task：下拉框选 `food-truck/master-data-management`，选分支，在 "Context repositories" 加上 `team-cookbook-feature`、`team-cookbook-kb`（原型 新建任务 · 开发模式）。
4. 任务运行：agent 先读 `../team-cookbook-feature/MD-18901.md`，再改代码、跑测试、push、开 PR（原型 Session · 开发模式）。PR 作者是本人。
5. 可选：在 Settings › Skills 建自己的 skill，之后在对话框用 `/name` 调用。

**验收**
- 没有 GitHub App 安装也能完成以上流程。
- GitHub 上 commit 作者、push 者、PR 创建人都是本人。
- 上下文仓库出现在 `/workspace/` 下且无法 push。
- PAT 失效时：新建任务页提示并禁用发送；运行中的任务明确报错"请更新 token"，不会悄悄换别的凭证。

### 6.2 产品

> 作为产品，我不想选仓库，我想直接让 agent 帮我按团队的方式写需求。

1. 首次登录看到引导 → 复制申请文案给管理员。
2. 管理员分配 `cookbook-PM-agent` 后，New task 下拉框出现 Agents 组（原型 新建任务 · 产品/测试看到的下拉框）。
3. 选 agent，输入 `/write-prd 把 MD-18901 …`（原型 新建任务 · Agent 模式 + / 命令）。工作区卡片显示 agent 能用的仓库和权限，不可改。
4. 任务运行：agent 读需求和代码，把 PRD 写入 `team-cookbook-kb`，push 到 main（原型 Session · 产品 agent 写 PRD）。commit 作者是本人。
5. Settings › My agents：在提示词后面加自己的要求、勾上自己的 skill（原型 Settings · My agents）。

**验收**
- 产品不需要创建任何 token。
- 代码仓库只读：agent 尝试修改或 push 代码仓库会失败，并且提示词里已说明只读。
- kb 仓库的 commit 作者和 push 者都是本人（前提：本人在 ct-kb 该仓库有写权限，GitHub App 已装到 ct-kb）。
- 个人定制只影响自己；管理员改了 agent 定义后，下一个任务生效。

### 6.3 测试

> 作为测试，我想根据需求和真实代码改动写用例，并存进用例仓库。

路径同产品，区别在 agent：`cookbook-testing-agent` 对代码、需求、kb 只读，对 `cookbook-test-cases` 可写（原型 Session · 测试 agent 写用例）。常用 `/jira-test-doc`。

**验收**：同产品；用例文件落在 `cookbook-test-cases`，其他三个仓库无改动。

### 6.4 管理员

> 作为管理员，我想一次配置好每个团队的产品 / 测试 agent，然后按人分配。

1. Admin › Credentials：录入 `food-truck` 只读 token；平台自动探测它对每个仓库的读写能力（原型 Admin · Credentials）。
2. 在 GitHub 把 App 装到 `ct-kb`（平台外操作，页面有提示）。
3. Admin › Skills：发布 `write-prd`、`jira-test-doc` 等平台 skill（原型 Admin · Skills）。
4. Admin › Agents：新建 `cookbook-PM-agent`：团队 cookbook、仓库 + 权限（只能选凭证 / App 覆盖的仓库，权限不能超过上限）、基础提示词、默认 skill；在 "Assigned people" 粘贴 login 列表（原型 Admin · Agents）。
5. 同样方式建 `cookbook-testing-agent`、`consumer-*`。

**验收**
- 录入可写的 token 作为只读凭证时，仓库能力表会显示 write，管理员能看到；agent 配 read 时平台仍禁用 push。
- 分配时对方不需要先登录过平台。
- 某人在 write 仓库上没有 GitHub 权限时，分配列表行内提醒。
- 凭证到期前 14 天在列表标黄。

## 7. 页面规格

### 7.1 New task（`/chat`）

| 元素 | 规格 |
|---|---|
| 对象下拉框 | 两组：**Agents**（分配给我的，显示名字 + 团队）、**Repositories**（我的 PAT 可写的）。任一组为空时仍显示组标题和空状态文案。按钮文案随可选内容变化：`Select agent` / `Select agent or repository` |
| 开发模式 | 选仓库后出现：分支选择（默认分支）；Context repositories 多选（候选 = 我能读的 ∪ 平台能读的 − 主仓库；记住上次选择）；底部提示"commit / PR 以 <login> 身份" |
| agent 模式 | 隐藏分支选择；显示工作区卡片（仓库 + 权限，只读展示，链接到 My agents）和 skill 摘要 |
| 发送 | 未选对象或提示词为空时禁用。session 创建后模式与 agent 不可更改 |
| `/` 候选 | 输入行首 `/` 弹出；分组：agent 默认 skill / 我的 skill / 提示词模板 / 全局；键盘 ↑↓ Tab Enter Esc；发送后消息原样展示 |
| 无任何权限 | 顶部显示引导卡片（§7.6），下拉框禁用 |

### 7.2 Session（`/sessions/:id`）

| 元素 | 规格 |
|---|---|
| 标题栏 | 开发模式：主仓库（蓝）+ 分支；agent 模式：agent 名（橙） |
| Workspace 栏 | 每个仓库一个 chip：primary / context 标签 + read / write 徽章；右侧写明身份和目标分支 |
| 对话 | 和现在一致；工具调用显示相对路径时带仓库名前缀 |
| Diff 侧栏 | 按可写仓库分 tab；只读仓库没有 tab |
| 跟进输入 | 支持 `/` |

### 7.3 Settings › Account

| 元素 | 规格 |
|---|---|
| GitHub 卡片 | 现有 |
| PAT 卡片 | 状态：未绑定 / 有效 / 等待审批 / 失效 / 不属于本人（原型右侧可切换）。保存时：`GET /user` 校验 id = 登录人；读过期时间、scope；探测可写仓库；fine-grained 对组织仓库 403/404 → "等待审批"。永不回显完整 token，只显示末 4 位。有效期 ≤ 14 天标黄 |
| 引导 | 推荐 classic（`repo` + `workflow`）；fine-grained 说明需审批；SSO 提示 |

### 7.4 Settings › My agents

| 元素 | 规格 |
|---|---|
| 列表 | 分配给我的 agent；已定制的标 customized；空状态提示找管理员 |
| 仓库 | 只读展示 |
| 提示词 | 文本域预填 agent 默认；编辑即覆盖；Reset to default 清空覆盖；保存后下一个任务生效 |
| Skills | 复选：agent 默认（可取消）、我的、其他已启用平台 skill（可添加）。标签区分 platform / mine |

### 7.5 Settings › Skills

| 元素 | 规格 |
|---|---|
| 列表 | Mine（可编辑）/ Platform（只读） |
| 编辑器 | name（`^[a-z0-9-]+$`，即 `/name`）、type（skill / prompt）、description、content（Markdown，≤ 64 KB）；个人与平台同名允许，运行时个人优先 |
| 生效 | 开发模式自动带上我的 skill；agent 模式需在 My agents 勾选 |

### 7.6 首次登录引导

无 PAT 且无 agent 时显示在 New task 顶部，不阻塞。两条并列路径：写代码 → 去 Settings 加 token；产品 / 测试 → 复制申请文案（含本人 login）发给管理员。满足任一条件后自动消失。替换现有"安装 GitHub App"引导。

### 7.7 Admin › Credentials（operator）

| 元素 | 规格 |
|---|---|
| 列表 | 每个 token 一张卡：label、类型、所属账号、末 4 位、过期、探测时间；Re-probe / Replace / Remove |
| 仓库能力表 | 每个私有仓库：Read / Write 探测结果、被哪些 agent 使用 |
| 添加 | label + provider + token；保存即探测（`GET /user`、私有仓库分页、逐仓库 upload-pack / receive-pack） |
| GitHub App 提示 | 显示 App 已安装的组织和仓库数；说明这些组织走用户本人登录 |
| 删除 | 若有 agent 依赖，二次确认并列出受影响的 agent |

### 7.8 Admin › Agents（operator）

| 元素 | 规格 |
|---|---|
| 列表 | 按团队分组；显示仓库数、分配人数 |
| 基本信息 | name、team、description |
| 仓库 | 每行：仓库、Access（read / write）、运行时凭证来源（平台凭证 label 或 "用户登录（App）"）；添加候选只列可达仓库并标最高权限；Access 上限校验 |
| 基础提示词 | 文本域 |
| 默认 skill | 从平台 skill 选 |
| 分配 | 粘贴 login（逗号 / 换行分隔）；平台换成 user id 存储；列表显示是否登录过、是否定制、权限告警；Revoke |
| 归档 | 归档后不再可选，已有 session 可查看 |

### 7.9 Admin › Skills（operator）

表格：name、description、type、被哪些 agent 使用、Global（所有任务都带）、Enabled；新建 / 编辑同 §7.5 的编辑器。

## 8. 权限与身份规则（面向产品的版本）

| 场景 | 用谁的身份 | GitHub 上显示 |
|---|---|---|
| 开发改 `master-data-management` | 本人 PAT | commit、push、PR 都是本人 |
| 产品 / 测试写 `ct-kb/*` | 本人登录（App 装在 ct-kb） | commit、push 都是本人 |
| 产品 / 测试读 `master-data-management` | 平台只读 token | 不产生提交 |
| agent 标为 read 的仓库 | 任何凭证 | 平台禁用 push，提示词声明只读 |

规则：平台永远不用共享账号替人提交代码；任何一次任务用了哪些凭证都记录在运行快照里。

## 9. 异常与边界

| 情况 | 行为 |
|---|---|
| PAT 过期 / 被撤销 | 新建任务：提示并禁发；运行中：任务失败，错误指向 Settings |
| fine-grained PAT 等待审批 | Settings 显示"等待审批"，可 Re-check；新建任务里该仓库不出现在 Repositories 组 |
| 平台凭证过期 | 依赖它的 agent 新建任务时报错"凭证 <label> 已过期，请联系管理员"；管理员列表标红 |
| 产品在 ct-kb 仓库无写权限 | 分配时行内告警；任务运行 push 失败并给出明确原因 |
| 管理员把 agent 某仓库从 write 改 read | 下一个任务生效；进行中的 session 下一轮按新权限 |
| agent 被归档 / 分配被撤销 | 新建任务不可选；已有 session 只读查看，不能继续 |
| 输入的 `/name` 不存在 | 原样作为普通文本发送 |

## 10. 指标

- 产品 / 测试首次成功完成任务的时间（从被分配到第一个 session 完成）。
- 开发绑定 PAT 的比例；因 PAT 失效导致的任务失败数。
- 每个 agent 的周活、任务数；只读仓库上的 push 失败次数（应接近 0）。

## 11. 发布计划

对应技术设计 §13 的 5 个阶段，每阶段一个 PR：

1. 凭证基础（PAT、平台凭证探测）→ 开发可用
2. 多仓库工作区（上下文仓库）
3. Agent（管理后台、分配、个人定制、新建任务页）→ 产品 / 测试可用
4. Skill 与 `/` 命令
5. 文档、审计、收尾

## 12. 待确认

- 产品 / 测试在各自 ct-kb 仓库的写权限是否已经到位（否则需要管理员先在 GitHub 加）。
- `cookbook-test-cases`、`team-cookbook-feature` 这些仓库是否都在 ct-kb 下并装 App（原型按此假设）。
- consumer 团队对应的代码仓库名（原型里写作 `wonder-consumer-project`，待确认）。
