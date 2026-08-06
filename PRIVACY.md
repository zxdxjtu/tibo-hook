# Privacy

本文说明 tibo-hook v0.1.0 在本机读取、保存和发送的数据。项目没有托管后端，也不提供遥测服务。

## 数据流

| 数据 | 来源 | 用途 | 是否持久化 |
|---|---|---|---|
| `session_id`、`turn_id` | Codex Hook input | 当前 turn 注册及安装内 HMAC 事件 ID | 原始值否；只保存 HMAC 派生值 |
| transcript 路径 | Codex Hook input | 在当前 EOF 后增量读取 | 否 |
| `cli_version`、surface、模型 | Hook/transcript 元数据 | 兼容门控及模板变量 | 仅保存必要状态或诊断类别 |
| `usage_limit_exceeded` 与 reset metadata | transcript 结构化记录 | 唯一真实触发条件及窗口去重 | 保存净化事件状态，不保存完整记录 |
| `tiboEmail`、`userEmail`、用户陈述 | `PLUGIN_DATA/config.json` | 渲染邮件 | 是，明文保存在用户本机 |
| SMTP host、username、from address | `PLUGIN_DATA/config.json` | 可选 SMTP 投递 | 是，明文保存在用户本机 |
| SMTP password | `passwordEnv` 指定的进程环境变量 | SMTP authentication | 不写入配置、journal 或日志 |
| 邮件头与正文 | 模板和净化事件 | `.eml` 草稿、preview 或 SMTP | 草稿/preview/spool 中明文保存，默认保留 30 天 |

## transcript 边界

真实 detector 会读取 transcript 的首条 `session_meta`，随后只处理当前 prompt 注册 EOF 之后的新 JSONL 行。parser 只投影兼容版本、surface、结构化 rate-limit metadata 和精确 `usage_limit_exceeded` 错误码。

以下内容不会进入邮件、journal 或诊断日志：

- prompt；
- assistant、reasoning 或 tool output；
- 完整 transcript 记录或路径；
- 完整错误消息；
- workspace 文件内容。

JSON 对象在解析过程中仍会短暂存在于进程内存。拥有同一系统用户权限、调试权限或进程内存访问能力的软件不在本项目的隔离边界内。

## 本地文件

所有业务数据位于 Codex 为 `tibo-hook@tibo-hook` 分配的 `PLUGIN_DATA`，而不是 Git 仓库。POSIX 平台使用目录 `0700`、文件 `0600`；Windows 权限为平台 best effort，并依赖当前用户的 ACL。

`.eml` 是真实邮件文件，因此会包含 `To`、`From`、`Reply-To`、主题、用户陈述和额度事件元数据。请把它视为敏感明文。磁盘备份、云同步、恶意软件、同一用户运行的进程或管理员仍可能读取这些文件。

草稿、preview 和未确定投递结果的 spool 最长保留 30 天并进行 best-effort 清理。去重 journal 为执行滚动 30 天策略而保留 HMAC key、状态和时间戳，不包含明文邮箱。

## 网络访问

默认 `autoSend=false` 时，真实 detector 和草稿链路不访问 SMTP。

业务网络访问只有两种：

1. 用户显式启用 `autoSend=true` 后，向配置的 SMTP host 投递额度申请；
2. 用户显式运行 `smtp-test --to-self`，向配置的 `userEmail` 发送固定 self-test。

SMTP provider 会接触 envelope、邮件头、正文、认证用户名以及认证所需的秘密。项目不控制 SMTP provider 的日志、保留期限或隐私政策。

安装、更新时由用户执行的 `codex plugin`、GitHub 和 npm 命令属于开发/分发工具网络访问，不是 Hook runtime 遥测。

## 收件人与反滥用

项目不包含、抓取、推断或验证 Tibo 的邮箱。唯一业务收件人来自用户配置的单一 `tiboEmail`；不支持 CC、BCC、多个收件人、附件、HTML、跟踪像素或托管 relay。

同一结构化 reset window 最多产生一次投递，自动发送滚动 30 天硬上限为 3。该限制降低误发风险，但不构成收件人同意，也不能替代适用法律和邮件服务政策。

## Secrets

不要把 SMTP 密码写进配置。`smtp.passwordEnv` 只是环境变量名称；supervisor 从启动时继承的环境读取对应值。启用自动发送前，请确认：

- `PLUGIN_DATA/config.json` 未被不可信进程修改；
- SMTP host 是你信任的服务；
- 环境变量只包含为该 SMTP 身份准备的 app password，而不是复用的高权限凭据；
- Codex 重启后才能获得新设置的环境变量。

## 查看与删除

运行 `tibo-hook config path` 查看配置和模板路径，运行 `tibo-hook status` 查看脱敏状态。卸载插件前记录数据目录；若要删除本地数据，请先停止 Codex/supervisor，核对目标确实是该插件的 `PLUGIN_DATA`，再使用操作系统提供的安全删除方式。

不要把配置、`.eml`、journal、日志或 SMTP 测试输出附在公开 issue 中。安全问题请使用 [SECURITY.md](./SECURITY.md) 的私密渠道。
