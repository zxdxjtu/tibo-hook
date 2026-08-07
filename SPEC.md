# tibo-hook 产品规格

> 状态：Proposed
> 目标版本：v0.1.0 Experimental
> 目标读者：实现者、维护者、插件审核者

## 1. 产品意图

当 Codex 因账号用量限制而终止当前 turn 时，tibo-hook 把这次事件转成一封事先准备、可由用户完整修改的英文邮件。用户可以选择只生成 `.eml` 草稿，也可以通过自己的 SMTP 账号自动发送。

这个项目解决两个问题：

1. 在额度错误发生后，Codex 本身可能已经无法继续调用模型，因此邮件不能依赖触发时再次生成内容。
2. 自动发送属于外部副作用，必须有明确配置、去重、频率上限和可审计状态。

v0.1.0 的真实错误检测标记为 **Experimental**。当前 Codex Hook 没有模型请求失败或 429 事件；`Stop` 也不是失败后的 `finally` Hook。v0.1.0 使用 `UserPromptSubmit` 注册 transcript watcher，并从后续 transcript 记录中确认结构化 `usage_limit_exceeded`。Codex 官方明确说明 transcript 格式不是稳定的 Hook 接口，因此解析失败时必须关闭触发，而不是猜测错误含义。[Hooks 文档](https://learn.chatgpt.com/docs/hooks)

## 2. 成功标准

tibo-hook v0.1.0 满足以下条件时视为达到产品目标：

- 可以作为 marketplace plugin 安装到 Codex App 和 Codex CLI。
- 用户能在额度耗尽前完成配置、编辑模板和预览。
- 对兼容版本中的结构化 `usage_limit_exceeded` 事件，生成一封且仅一封草稿或 SMTP 投递。
- 普通瞬时 429、重试耗尽、服务过载、工具失败和正常 `Stop` 不触发邮件。
- 自动发送默认关闭；开启后仍受每窗口一次和滚动 30 天最多 3 封约束。
- 邮件和日志不包含 prompt、assistant 回复、transcript 正文、完整错误消息或凭据。
- 未知 Codex 版本、缺失 transcript、格式漂移和不明确的发送结果均 fail closed。

额度是否被重置或提高不属于成功标准，项目不对此作任何承诺。

## 3. 支持范围

| 表面 | v0.1.0 | 说明 |
|---|---:|---|
| Codex App | Experimental | 需要 Node.js 20+ 可被 Hook 进程从 `PATH` 找到 |
| 交互式 Codex CLI | Experimental | 以明确列入兼容清单的 Codex 版本为准 |
| 普通 `codex exec` | 不承诺 | 可保留 transcript 时可能工作，但不列入 v0.1.0 验收范围 |
| `codex exec --ephemeral` | 不支持 | 没有可供 watcher 使用的持久 transcript |
| Codex IDE extension | 不支持 | v0.1.0 不声明该表面的 Plugin/Hook 兼容性 |
| API key 额度管理 | 不支持 | 产品面向 ChatGPT 登录的 Codex 账号，不替代 API billing/support 流程 |

首次兼容基线为 `codex-cli 0.144.3`。兼容清单必须随插件发行，不得把未经 fixture 和 smoke test 验证的新版本自动视为支持。

## 4. 用户流程

### 4.1 安装与信任

仓库 marketplace 名称固定为 `tibo-hook`，插件名固定为 `tibo-hook`。CLI 安装流程为：

```bash
codex plugin marketplace add zxdxjtu/tibo-hook
codex plugin add tibo-hook@tibo-hook
```

Codex App 用户通过 Plugins Directory 选择同一 marketplace 后安装。

Marketplace 安装只安装插件，不会把第三方可执行文件链接到系统 `PATH`。为使下文的裸 `tibo-hook` 命令成为真实的公共 CLI 契约，发行物同时提供同版本 companion npm CLI；需要从终端管理配置的用户还要执行：

```bash
npm install --global @zxdxjtu/tibo-hook
```

companion CLI 只定位并调用已安装插件的同一单文件 runtime，不维护第二份业务实现。它必须校验 plugin ID 与版本，默认定位 `tibo-hook@tibo-hook` 的 `${PLUGIN_DATA}`；如果发现零个或多个候选、版本不一致，必须退出并要求用户显式指定 `TIBO_HOOK_PLUGIN_DATA`，不能猜测目录。插件内 bundled setup skill 提供等价的 Codex 内管理入口，因此不想全局安装 npm CLI 的用户仍可完成初始化、校验、预览和状态检查。具体载体见 `DESIGN.md`。

安装或升级插件不会自动信任其中的命令 Hook。用户必须在 Codex CLI 中打开 `/hooks`，核对命令及来源后再信任。Hook 定义发生变化时，Codex 会要求重新审核。[Plugin Hook trust](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks)

### 4.2 初始化

用户运行：

```bash
tibo-hook init
```

`init` 在 `${PLUGIN_DATA}` 下创建：

```text
${PLUGIN_DATA}/
├── config.json
├── templates/
│   └── request.txt
├── drafts/
├── previews/
├── outbox/
├── state/
└── logs/
```

已存在的配置或模板不得被覆盖。目录权限为 `0700`；配置、模板、状态和草稿文件权限为 `0600`。

`init` 同时用系统 CSPRNG 生成 `state/install.key` 与 `state/ipc.key`。已存在的 key 永不覆盖；两者都缺失时，也只有在不存在 journal、snapshot、outbox 或 draft 状态的全新数据目录中才可生成。如果发现只有一个 key、长度错误或权限不安全，初始化必须停止并给出恢复指引，不能用新 key 掩盖可能存在的旧投递 ledger。

### 4.3 编辑、校验与预览

用户填写 `tiboEmail`、`userEmail`、个人背景与 SMTP 配置，并直接编辑 `templates/request.txt`。推荐顺序：

```bash
tibo-hook config path
tibo-hook validate
tibo-hook preview
```

`preview` 使用合成事件渲染完整邮件并写入 preview 文件，不打开网络连接。

### 4.4 选择投递方式

- `autoSend=false`：真实触发后只生成 `.eml` 草稿。
- `autoSend=true`：真实触发后使用 SMTP 自动发送。

修改配置或模板后，新事件立即使用新内容。v0.1.0 不增加模板哈希审批步骤。配置校验失败时不得发送。

### 4.5 查看状态

```bash
tibo-hook status
```

输出最近事件、投递状态、窗口去重和月度上限信息。邮箱只显示脱敏形式，输出中不得出现邮件正文、transcript 路径、完整错误消息或 SMTP 密码。

## 5. 触发契约

### 5.1 Hook 行为

v0.1.0 使用三个 Hook：

| Hook | 行为 | 是否判断错误 |
|---|---|---:|
| `SessionStart` | 启动或健康检查本地 supervisor | 否 |
| `UserPromptSubmit` | 在模型请求前记录 `turn_id`、transcript 路径和当前 EOF | 否 |
| `Stop` | 标记该 turn 正常完成并清理 watcher | 否 |

`PostToolUse` 不参与检测。它只观察受支持的本地工具调用，模型采样请求不是工具调用。[Tool coverage](https://learn.chatgpt.com/docs/hooks#tool-coverage)

### 5.2 唯一正触发条件

registration 允许在 EOF 之前读取且只读取首条 `session_meta`，用于取得 `cli_version` 与 surface；它不得扫描历史事件。watcher 只读取注册 EOF 之后追加的完整 JSONL 记录。以下条件必须同时成立：

```text
record.type == "event_msg"
record.payload.type == "error"
record.payload.codex_error_info == "usage_limit_exceeded"
```

此外还必须满足：

- 事件属于已注册且尚未结束的 session/turn。
- transcript 的 `cli_version` 位于当前插件兼容清单。
- transcript schema 通过当前 parser 的完整结构校验。

满足以上条件后 detector 创建已净化的候选；`EventFactory` 读取当前配置中的去重身份并完成 `RateLimitEvent`。是否生成草稿或连接 SMTP 是后续策略决策：配置或模板无效时只记录诊断；重复窗口或月度上限命中时记录 `suppressed`。这些结果不改变“detector 已确认结构化额度事件”的事实。

不得以错误消息中的 `429`、`rate limit`、本地化文案或正则表达式作为自动发送依据。

### 5.3 不触发条件

以下情况均不进入邮件投递链路：

- `codex_error_info` 缺失或值不是 `usage_limit_exceeded`。
- `response_too_many_failed_attempts`、`server_overloaded`、网络中断或请求超时。
- Bash、MCP、`apply_patch` 或其他工具调用返回失败。
- 收到正常 `Stop`。
- transcript 不存在、不可读、被截断、单行超过安全上限或结构未知。
- Codex 版本未列入兼容清单。
- 不能确认当前环境为本产品支持的 ChatGPT Codex 使用场景。

Codex 当前可能把内部的 `UsageLimitReached`、`QuotaExceeded` 和 `UsageNotIncluded` 合并为公开的 `UsageLimitExceeded`。v0.1.0 以公开结构化错误码为边界，不宣称能恢复内部原始错误种类。

## 6. 事件模型

检测层经 `EventFactory` 向邮件链路输出统一的 `RateLimitEvent`。这是 detector adapter 与邮件链路之间的稳定内部契约；detector 的私有候选不含 `eventId` 或 `windowKey`：

```ts
type RateLimitEvent = {
  schemaVersion: 1;
  eventId: string;
  sessionId: string;
  turnId: string;
  occurredAt: string; // RFC 3339 UTC
  surface: "codex-app" | "codex-cli" | "unknown";
  model: string;
  codexVersion: string;
  errorCode: "usage_limit_exceeded";
  limitKind: string | null;
  resetAt: string | null; // RFC 3339 UTC
  windowKey: string;
  detector: "transcript-experimental" | "debug-synthetic" | "app-server" | "turn-error-native";
};
```

`RateLimitEvent` 禁止包含：

- prompt 或 assistant 内容；
- transcript 原文或完整路径；
- 完整错误消息；
- SMTP 密码、API key、登录 token；
- 与邮件所需信息无关的工作区路径或文件内容。

`${PLUGIN_DATA}/state/install.key` 保存每次安装独有的 32-byte 随机密钥。`eventId` 和 `windowKey` 使用带版本域分离的 HMAC-SHA-256 派生值；日志只记录这些不可跨安装关联的标识符。密钥丢失或损坏时必须禁用自动发送，不得静默生成新密钥并遗忘既有去重状态。

## 7. 窗口与频率策略

### 7.1 窗口键

目标 Error 记录本身不提供 `turnId`、`limitKind` 或 `resetAt`：`turnId` 来自 `UserPromptSubmit` registration；后两者只能来自同一 registration EOF 之后、目标错误之前且通过兼容 parser 校验的结构化 rate-limit snapshot。snapshot 自身永不触发邮件。没有无歧义 snapshot 时，`limitKind` 使用固定哨兵 `usage_limit`，`resetAt=null`。

如果存在无歧义的结构化 `resetAt`，`windowKey` 使用以下字段计算：

```text
HMAC(installKey, "window-v1" || userEmail || tiboEmail || limitKind || resetAt)
```

不得从自然语言错误消息中解析 reset time。

如果没有结构化 `resetAt`，使用事件发生时间所在的 UTC 24 小时 bucket：

```text
HMAC(installKey, "window-v1-fallback" || userEmail || tiboEmail || limitKind || utcDate)
```

上述 `||` 表示确定性的长度前缀 UTF-8 tuple 字段边界，不是无分隔字符串拼接。邮箱只在 policy key 中使用规范化形式，实际邮件头保持用户配置的地址。

### 7.2 强制约束

- 同一 `windowKey` 最多生成一次外部投递尝试。
- `accepted`、`unknown` 和正在处理的 `reserved` 都占用窗口。
- 滚动 30 天内，`accepted` 与 `unknown` 合计最多 3 次。
- 滚动窗口以自动投递 reservation 的本机 UTC 时间为准，区间为当前决策时刻之前的连续 `30×24` 小时；terminal state 保留原始 `reservedAt`，不用 transcript 的 `occurredAt` 计数。
- 该上限按安装全局计算；修改 `userEmail`、`tiboEmail`、模板或 SMTP 身份不能重置计数。并发中的 `reserved` 临时占用名额，转为 `rejected` 后释放。
- `policy.maxPerRolling30Days` 默认值为 3，允许用户调低，不允许设置为大于 3。
- 草稿模式不消耗自动发送月度配额，但同一窗口只生成一个正式草稿。
- 达到月度上限时写入 `suppressed` 状态，可生成带有抑制原因的本地预览，但不得连接 SMTP。

## 8. 配置契约

业务配置只存在于 `${PLUGIN_DATA}/config.json`，不得添加到 Codex `plugins.*` 配置表。

### 8.1 完整示例

```json
{
  "schemaVersion": 1,
  "tiboEmail": "tibo@example.com",
  "userEmail": "me@example.com",
  "requesterName": "Your Name",
  "useCase": "I use Codex to maintain an open-source developer tool and validate cross-platform fixes.",
  "impact": "When the limit is reached, active debugging sessions stop before I can verify and document the fix.",
  "feedback": "The structured error is clear, but an earlier warning and a visible reset window would make long-running work easier to plan.",
  "templatePath": "templates/request.txt",
  "subjectTemplate": "Request for a Codex usage-limit review — {{requesterName}}",
  "autoSend": false,
  "smtp": {
    "host": "smtp.example.com",
    "port": 587,
    "security": "starttls-required",
    "username": "me@example.com",
    "fromEmail": "me@example.com",
    "passwordEnv": "TIBO_HOOK_SMTP_PASSWORD",
    "timeoutMs": 15000
  },
  "debug": {
    "triggerNextPrompt": false
  },
  "policy": {
    "maxPerRolling30Days": 3
  }
}
```

示例邮箱只用于展示格式。仓库、发行包和默认配置中不得包含真实 Tibo 邮箱。

`init` 生成相同 schema 的待填写骨架：六个必填用户字段以及 `smtp.host/username/fromEmail` 为空字符串，`smtp.port=587`、`smtp.security="starttls-required"`，其余默认值与上例一致。空字符串不是有效配置；在用户填写前 `validate` 必须失败，Hook 只能记录 `config_invalid` 诊断。`autoSend=false` 时也允许完全省略 `smtp` 对象。

### 8.2 字段规则

| 字段 | 必填 | 默认值 | 约束 |
|---|---:|---|---|
| `schemaVersion` | 是 | `1` | v0.1.0 只接受整数 `1` |
| `tiboEmail` | 是 | 无 | 唯一 `To`，必须通过邮箱语法和 Header 注入校验 |
| `userEmail` | 是 | 无 | 用于正文与 `Reply-To` |
| `requesterName` | 是 | 无 | 1–120 个 Unicode 字符，不允许控制字符 |
| `useCase` | 是 | 无 | 20–2000 个 Unicode 字符 |
| `impact` | 是 | 无 | 20–2000 个 Unicode 字符 |
| `feedback` | 是 | 无 | 20–2000 个 Unicode 字符，要求描述真实体验 |
| `templatePath` | 否 | `templates/request.txt` | 解析后的规范路径必须位于 `${PLUGIN_DATA}` 内 |
| `subjectTemplate` | 否 | 见示例 | 渲染后不超过 200 字符，禁止 CR/LF |
| `autoSend` | 否 | `false` | `true` 时要求完整 SMTP 配置和已验证兼容版本 |
| `smtp.host` | `autoSend=true` 时 | 无 | 非空主机名；v0.1.0 不支持任意 HTTP relay |
| `smtp.port` | `autoSend=true` 时 | 无 | 只接受 `587` 或 `465` |
| `smtp.security` | `autoSend=true` 时 | 无 | `starttls-required` 或 `implicit-tls`，必须与端口匹配 |
| `smtp.username` | `autoSend=true` 时 | 无 | SMTP 认证用户名 |
| `smtp.fromEmail` | `autoSend=true` 时 | 无 | 必须是 SMTP 服务已认证或已验证的发件身份 |
| `smtp.passwordEnv` | `autoSend=true` 时 | `TIBO_HOOK_SMTP_PASSWORD` | 只保存匹配 `[A-Za-z_][A-Za-z0-9_]*` 的环境变量名，不允许保存秘密值 |
| `smtp.timeoutMs` | 否 | `15000` | 1000–60000 ms |
| `debug.triggerNextPrompt` | 否 | `false` | 一次性布尔开关，消费后原子复位 |
| `policy.maxPerRolling30Days` | 否 | `3` | 整数 1–3 |

SMTP 密码必须通过 `smtp.passwordEnv` 指定的环境变量注入 Hook 进程。若 Codex App 的启动环境没有该变量，自动发送 preflight 失败并退回草稿，不得把密码写入配置或日志。

修改环境变量不会改变已运行 supervisor 的进程环境；用户必须重启 Codex/supervisor。`smtp-test` 只证明发起该命令的进程能取到密码，`validate/status` 还必须分别报告 supervisor 是否可见该变量，且永不输出其值。

`tiboEmail`、`userEmail` 与 `smtp.fromEmail` 只接受单一 ASCII addr-spec，不接受 display name、SMTPUTF8、逗号或分号分隔的地址；`tiboEmail` 与 `userEmail` 规范化后必须不同。schema v1 对未知字段报错，避免拼写错误被静默忽略。

插件只能校验 `smtp.fromEmail` 的语法及 SMTP server 是否接受该 envelope identity，无法替邮件服务证明域名所有权。用户必须在提供商侧先完成 sender 验证；默认建议让 `smtp.fromEmail` 与已认证账号相同。

## 9. 模板契约

### 9.1 默认主题

```text
Request for a Codex usage-limit review — {{requesterName}}
```

### 9.2 默认正文

`init` 生成以下英文纯文本模板：

```text
Hi Tibo,

I'm writing to ask whether my Codex usage limit can be reviewed.

What I use Codex for
{{useCase}}

What happened
At {{occurredAt}}, Codex {{codexVersion}} reported a usage limit while I was using {{model}} through {{surface}}. The limit was {{limitKind}}, and the reported reset time was {{resetAt}}.

Why additional capacity would help
{{impact}}

Concrete feedback
{{feedback}}

I understand that additional capacity cannot be guaranteed. If a reset or limit adjustment is possible, I would be grateful; otherwise, I hope this context is useful feedback for the Codex team.

Best,
{{requesterName}}
{{userEmail}}
```

### 9.3 变量白名单

| 变量 | 来源 | 缺失值 |
|---|---|---|
| `requesterName` | 配置 | 校验失败 |
| `userEmail` | 配置 | 校验失败 |
| `useCase` | 配置 | 校验失败 |
| `impact` | 配置 | 校验失败 |
| `feedback` | 配置 | 校验失败 |
| `occurredAt` | `RateLimitEvent` | 不允许缺失 |
| `surface` | `RateLimitEvent` | `unknown` |
| `model` | `RateLimitEvent` | `unknown` |
| `codexVersion` | `RateLimitEvent` | 不允许缺失 |
| `limitKind` | `RateLimitEvent` | `Codex usage` |
| `resetAt` | `RateLimitEvent` | `not reported by Codex` |

模板只支持 `{{variable}}` 替换，不支持条件、循环、函数、include、环境变量展开或任意文件读取。发现未知变量、未闭合占位符或缺失必填值时校验失败。渲染后的 UTF-8 正文不得超过 10 KiB。

`useCase`、`impact` 与 `feedback` 允许 LF 和 TAB；NUL、CR 和其他控制字符必须拒绝。变量值只做一次字面量替换，值中出现的 `{{...}}` 不再递归解析。

## 10. 投递契约

### 10.1 邮件头

```text
To: tiboEmail
From: smtp.fromEmail
Reply-To: userEmail
Subject: rendered subjectTemplate
```

v0.1.0 只允许单一 `To`，不支持 `Cc`、`Bcc`、附件、HTML、跟踪像素或回执请求。

### 10.2 SMTP

- 587 端口必须成功升级到 STARTTLS，否则终止。
- 465 端口从连接开始使用 TLS。
- 必须校验证书和主机名，不提供关闭校验的配置。
- 每次事件使用独立连接，不启用连接池或库级自动重试。
- 邮件服务自身返回的 429 或其他错误不得进入 Codex 额度 detector。

### 10.3 结果语义

| 状态 | 含义 | 后续动作 |
|---|---|---|
| `reserved` | 已在本地占用窗口，尚未得到 SMTP 结果 | 不允许并发重复投递 |
| `accepted` | SMTP server 已接受消息 | 结束，不重试 |
| `rejected` | 可确认服务器未接受 | 写入失败状态并生成草稿 |
| `unknown` | DATA 提交后断线、进程崩溃或结果不明确 | 占用窗口与月度额度，不自动重试 |
| `drafted` | `autoSend=false` 或安全 preflight 失败 | 保留 `.eml` 供用户检查 |
| `suppressed` | 命中窗口去重、月度上限或兼容性策略 | 不连接 SMTP |

## 11. Debug 与诊断

### 11.1 下一次 prompt 测试

```bash
tibo-hook debug-next
```

该命令把 `debug.triggerNextPrompt` 设置为 `true`。下一个 `UserPromptSubmit` Hook：

1. 原子地把开关恢复为 `false`；
2. 生成 detector 为 `debug-synthetic` 的测试事件；
3. 走配置、策略和模板渲染链路；
4. 强制输出 preview；
5. 不读取 transcript 错误、不打开 SMTP、不占用窗口或月度额度。

### 11.2 SMTP self-test

```bash
tibo-hook smtp-test --to-self
```

这是显式外部副作用，只允许 `To=userEmail`。命令不得接受任意 `--to` 地址，也不得退化为向 `tiboEmail` 发送测试邮件。

self-test 不使用额度申请模板，固定主题为 `tibo-hook SMTP self-test`，正文只说明这是一封投递到已配置 `userEmail` 的本地测试邮件。它可在 `autoSend=false` 时显式运行，但仍要求完整 SMTP/TLS/sender 配置；它不创建 rate-limit fingerprint，也不消耗滚动 30 天配额。

### 11.3 Doctor

`tibo-hook validate` 至少检查：

- Node.js 主版本；
- 配置 schema 与模板；
- `PLUGIN_DATA` 权限；
- Codex 版本兼容性；
- Hook 配置是否存在；
- transcript 是否可用；
- `autoSend=true` 时 SMTP 密码环境变量是否可见；
- 当前登录场景是否符合 ChatGPT Codex 的产品范围。

校验不得通过制造真实 429 或发送真实 Tibo 邮件完成。

## 12. CLI 契约

下表是稳定的用户命令语义。裸命令由可选 companion npm CLI 提供；bundled setup skill 必须调用插件内相同 runtime 并呈现等价结果。两种载体都操作同一个 `${PLUGIN_DATA}`，且 companion 版本必须与插件版本一致。Hook 内部的 `hook ...`、`supervisor` 和 IPC 命令不属于公共 API。

| 命令 | 副作用 | 输出 |
|---|---|---|
| `tibo-hook init` | 创建缺失的配置、模板和数据目录 | 创建路径与下一步说明 |
| `tibo-hook config path` | 无 | `config.json` 与模板的绝对路径 |
| `tibo-hook validate` | 只读 | 逐项 PASS/WARN/FAIL；不输出秘密 |
| `tibo-hook preview` | 写本地 preview | 文件路径、主题和脱敏收件人 |
| `tibo-hook debug-next` | 原子修改 debug 开关 | 下一 prompt 将触发一次 preview |
| `tibo-hook smtp-test --to-self` | 向 `userEmail` 发送一封测试邮件 | SMTP 结果状态 |
| `tibo-hook status` | 只读 | 最近的脱敏事件、窗口和投递状态 |

公开命令成功返回 0；配置错误返回 2；不支持的运行环境返回 3；SMTP preflight/投递错误返回 4。Hook 内部命令无论内部诊断结果如何都应安静退出 0，避免改变 Codex turn；无法启动 Node 等宿主级命令错误仍由 Codex Hook 系统报告。

## 13. 隐私与防滥用要求

- 不内置、发现、抓取或联网查询 Tibo 邮箱。
- 只发送用户明确配置的单一地址。
- 不把用户 prompt、模型回复、工作区文件、transcript、完整错误消息或认证信息加入邮件。
- 不以隐藏方式更改 `autoSend`、收件人、模板或月度上限。
- 不提供批量收件人、任意 webhook、托管 relay 或后台遥测。
- debug 永远不产生发往 Tibo 的网络请求。
- 日志中的邮箱使用不可逆哈希和局部遮盖；秘密环境变量的值不得进入异常对象、诊断或状态文件。
- 草稿默认保留 30 天后清理；投递 ledger 至少保留覆盖滚动 30 天策略所需的信息。
- POSIX 数据目录使用 `0700`、文件使用 `0600`；Windows 使用当前用户专属 ACL，权限无法确认时禁用自动发送。
- `.eml` 作为实际邮件必然包含配置的 `To`、`From`、`Reply-To`，默认模板还包含 `userEmail`；除此之外不得出现 transcript 或凭据中的地址。日志、状态和 CLI 输出仍不得包含完整邮箱。

## 14. 非目标

v0.1.0 不负责：

- 代表 OpenAI、Codex 或 Tibo 提供官方服务；
- 保证 Tibo 阅读、回复、重置或提高额度；
- 在错误发生后调用 Codex 或其他 LLM 重写邮件；
- 解析自然语言错误消息以推断 429；
- 重试失败的 Codex turn；
- 修改 Codex 的 rate-limit、登录或 billing 配置；
- 代替 OpenAI 官方支持、billing 或 workspace 管理流程；
- 为所有未来 transcript 格式提供无版本边界的兼容；
- 通过 OTel 直接触发自动发送；
- 支持 HTML 邮件、附件、群发、CC/BCC 或营销追踪。

## 15. 验收标准

### 15.1 正向场景

1. 兼容版本 fixture 在注册 EOF 后追加结构化 `usage_limit_exceeded`，`autoSend=false` 时生成一份 `.eml`。
2. 相同事件在 `autoSend=true` 时通过 SMTP fixture 发送一次，ledger 为 `accepted`。
3. 新 reset window 可以再次触发；同一 window 的串行和并发重复事件不能产生第二次投递。
4. 缺失结构化 reset time 时，同一 UTC 日期只允许一次，下一 UTC 日期形成新 fallback window。
5. 用户编辑模板后，下一事件使用新模板内容。

### 15.2 负向场景

1. 普通 HTTP 429 文本、`response_too_many_failed_attempts`、`server_overloaded` 和工具错误均不触发。
2. 正常 `Stop` 只清理 watcher，不产生邮件。
3. 未知 Codex 版本、缺失 transcript、partial JSONL、截断文件、超大行和 schema drift 不触发。
4. 第 4 次滚动 30 天自动发送被标记为 `suppressed`，SMTP fixture 没有连接记录。
5. `autoSend=false`、debug 和 preview 测试都没有任何外部网络连接。
6. debug 在下一 prompt 触发一次并自动复位，第二个 prompt 不再触发。
7. 无效邮箱、未知模板变量、路径逃逸、主题 CR/LF 和正文超过 10 KiB 均阻止发送。
8. SMTP 结果为 `unknown` 时，重启后不自动重试。

### 15.3 隐私场景

1. 所有测试日志、状态文件和 `.eml` 扫描均不出现 fixture 中的 prompt、assistant 文本、transcript 路径或密码；`.eml` 只允许出现配置声明的三个邮件地址。
2. debug 与 SMTP self-test 的收件人分别为本地 preview 和 `userEmail`，从未出现 `tiboEmail` 网络投递。
3. 状态输出只显示哈希事件 ID、状态、时间和脱敏邮箱。

## 16. 发布边界

v0.1.0 发布说明必须包含 `Experimental transcript detector` 标识、已验证 Codex 版本、Node.js 20+ 前置条件和已知不支持表面。

项目继续使用仓库现有 MIT License；发行前必须完成 bundled npm 依赖的许可证兼容性检查。

只有 Codex 提供携带结构化错误的公开 Hook，并完成 App/CLI 两个表面的兼容验证后，项目才能移除 detector 的 Experimental 标识。建议的未来接口定义见 `DESIGN.md`。
