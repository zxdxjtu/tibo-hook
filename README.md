# tibo-hook

`tibo-hook` 是一个实验性的 Codex Hook。它只在兼容版本的本地 transcript 中确认结构化 `usage_limit_exceeded` 事件后，生成一封请求复核 Codex 使用额度的英文纯文本邮件。

默认行为是生成权限为 `0600` 的本地 `.eml` 草稿。只有用户主动配置 `autoSend=true`、SMTP 和收件人后，它才会连接 SMTP。

> [!IMPORTANT]
> 本项目与 OpenAI、Codex 团队及 Tibo 没有隶属、授权或背书关系，不保证获得额外额度。项目不内置、不搜索、也不收集任何人的邮箱。请只使用你通过合规方式获得且有正当理由联系的地址，不要将本项目用于骚扰、群发或规避平台规则。

## 当前状态

| 项目 | v0.1.0 |
|---|---|
| 稳定性 | Experimental |
| 已验证 Codex 版本 | `0.144.3`（精确匹配） |
| 支持表面 | Codex App、交互式 Codex CLI |
| 不支持 | IDE extension、`codex exec --ephemeral` |
| 默认发送行为 | 只生成草稿，`autoSend=false` |
| 自动发送上限 | 同一 reset window 最多一次；滚动 30 天最多 3 封 |

transcript 不是稳定的公开 Hook 接口。未知 Codex 版本、未知 surface、普通 429 文本、服务过载、工具错误和 schema drift 都会 fail closed，不生成邮件。完整契约见 [SPEC.md](./SPEC.md)，实现设计见 [DESIGN.md](./DESIGN.md)。

## 工作方式

```text
SessionStart / UserPromptSubmit Hook
                ↓
      local singleton supervisor
                ↓
 version-gated transcript detector
                ↓
 policy + template + durable outbox
                ↓
       .eml draft（默认）/ SMTP
```

邮件链路不会调用 LLM，也不会把 prompt、assistant 回复、工具输出、完整错误文本或 transcript 内容加入邮件。

## 安装

### 1. 前置条件

- Node.js 20 或更高版本。
- 支持 `codex plugin` 的 Codex CLI。
- Codex App 的 Hook 环境能在 `PATH` 中找到 `node`。

```bash
node --version
codex plugin --help
```

### 2. 从 GitHub marketplace 安装（推荐）

以下命令遵循 Codex 的 [CLI marketplace 安装方式](https://developers.openai.com/plugins/build/plugins#add-a-marketplace-from-the-cli)：

```bash
codex plugin marketplace add zxdxjtu/tibo-hook --ref main
codex plugin add tibo-hook@tibo-hook
codex plugin list --marketplace tibo-hook --json
```

`plugin list` 应显示 `pluginId` 为 `tibo-hook@tibo-hook`，并且 `installed`、`enabled` 都为 `true`。

### 3. 从本地源码安装

```bash
git clone https://github.com/zxdxjtu/tibo-hook.git
cd tibo-hook
npm ci
npm run build
codex plugin marketplace add "$(pwd)"
codex plugin add tibo-hook@tibo-hook
```

PowerShell 中将 `"$(pwd)"` 换成 `(Resolve-Path .).Path`。

### 4. 审核 Hook 并初始化

安装不会自动信任 command Hook。启动一个新 Codex task，打开 `/hooks`，按 [Hook review and trust](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks) 检查以下三个命令都来自本插件且指向 bundled runtime，再显式信任：

- `SessionStart`
- `UserPromptSubmit`
- `Stop`

随后调用 bundled setup skill：

```text
Use $tibo-hook-setup to initialize and validate tibo-hook.
```

本地源码用户也可以直接运行同一份 runtime：

```bash
node plugins/tibo-hook/dist/tibo-hook.cjs init
node plugins/tibo-hook/dist/tibo-hook.cjs config path
```

裸命令 `tibo-hook` 是 companion npm 包提供的可选入口；截至 v0.1.0，该包尚未发布到 npm，请不要执行来源不明的同名全局包。

## 配置

`init` 会在 Codex 分配的私有 `PLUGIN_DATA` 中创建 `config.json`、模板、安装密钥和 outbox。它不会覆盖已有文件，也不会把配置写进仓库。

最小草稿配置示例：

```json
{
  "schemaVersion": 1,
  "tiboEmail": "recipient@example.invalid",
  "userEmail": "you@example.invalid",
  "requesterName": "Your Name",
  "useCase": "Describe your real Codex use case in at least 20 characters.",
  "impact": "Explain the concrete impact of the usage limit in at least 20 characters.",
  "feedback": "Share truthful, specific product feedback in at least 20 characters.",
  "templatePath": "templates/request.txt",
  "subjectTemplate": "Request for a Codex usage-limit review — {{requesterName}}",
  "autoSend": false,
  "debug": { "triggerNextPrompt": false },
  "policy": { "maxPerRolling30Days": 3 }
}
```

`example.invalid` 是不可投递的保留示例域名，必须替换。请勿提交真实邮箱、SMTP 配置或生成的 `.eml`。

校验并预览：

```bash
tibo-hook validate
tibo-hook preview
tibo-hook status
```

如果没有安装 companion CLI，请把 `tibo-hook` 替换为：

```bash
node /absolute/path/to/plugins/tibo-hook/dist/tibo-hook.cjs
```

## 可选：SMTP 自动发送

保持 `autoSend=false` 可以完整使用检测和草稿功能，且不会产生 SMTP 网络访问。

自动发送只允许以下组合：

- `587` + `starttls-required`
- `465` + `implicit-tls`

配置示例：

```json
{
  "autoSend": true,
  "smtp": {
    "host": "smtp.example.invalid",
    "port": 587,
    "security": "starttls-required",
    "username": "your-smtp-user",
    "fromEmail": "you@example.invalid",
    "passwordEnv": "TIBO_HOOK_SMTP_PASSWORD",
    "timeoutMs": 15000
  }
}
```

密码只能放入 `passwordEnv` 指定的进程环境变量：

```bash
export TIBO_HOOK_SMTP_PASSWORD='your-app-password'
```

不要把密码写入 `config.json`、shell history、issue、日志或截图。修改环境变量后需要重启 Codex/supervisor，已经运行的 supervisor 不会自动获得新环境。

SMTP self-test 会真实发送一封固定内容的邮件，但收件人强制为 `userEmail`：

```bash
tibo-hook smtp-test --to-self
```

## Debug

```bash
tibo-hook debug-next
```

它只作用于下一次 prompt：原子复位后生成一份发给 `userEmail` 的本地 preview，不读取额度错误、不连接 SMTP，也不占用 reset window 或滚动 30 天额度。

## 更新与卸载

更新 Git marketplace 后重新安装插件，并在新 task 中使用新版本：

```bash
codex plugin marketplace upgrade tibo-hook
codex plugin add tibo-hook@tibo-hook
```

卸载插件：

```bash
codex plugin remove tibo-hook@tibo-hook
codex plugin marketplace remove tibo-hook
```

卸载前可运行 `tibo-hook config path` 记录数据目录。插件数据可能包含配置、真实邮箱、邮件正文和草稿；Codex 是否保留该目录取决于当前插件存储行为，请在确认路径后自行决定是否删除。

## 隐私与安全

- 默认没有遥测、分析服务、托管 relay 或收件人发现。
- 真实 detector 只投影版本、surface、模型、结构化错误码和 reset metadata，不持久化 transcript。
- 日志不记录完整邮箱、邮件正文、SMTP username/password、prompt 或 transcript 路径。
- `.eml` 和配置为了完成用户请求必然包含明文邮箱及用户陈述，并以本地文件形式保存；磁盘备份、同步软件和同一系统用户仍可能访问它们。
- SMTP server 会看到 envelope、邮件头和正文；这是自动发送与 self-test 唯一的业务网络出口。
- `autoSend=true` 会让配置指定的 SMTP host 接收 `passwordEnv` 对应的密码用于认证。只在你信任 `PLUGIN_DATA/config.json` 和 SMTP host 时启用。

详情见 [PRIVACY.md](./PRIVACY.md)。安全漏洞请按 [SECURITY.md](./SECURITY.md) 私下报告，不要在公开 issue 中粘贴配置、邮件或凭据。

## 开发与验证

```bash
npm ci
npm run check
npm test
npm run verify
```

测试使用脱敏 JSONL fixtures 与注入式 SMTP transport，不主动耗尽真实额度，也不向真实地址发送邮件。构建产物是 `plugins/tibo-hook/dist/tibo-hook.cjs`；第三方许可见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

## 贡献

提交 PR 前请说明行为变化、隐私影响和验证结果。新增 Codex 兼容版本必须同时提供脱敏 fixture、parser 测试以及 App/CLI smoke evidence，不能仅修改 `compatibility.json`。

## License 与免责声明

项目源码采用 [MIT License](./LICENSE)。第三方组件保留各自许可。

“OpenAI”“Codex”及相关标识属于其各自权利人；“Tibo”仅用于描述项目灵感和用户自行配置的通信对象，不表示本人参与或认可本项目。使用者负责遵守适用法律、邮件服务条款、反垃圾邮件规则以及收件人的合理预期。
