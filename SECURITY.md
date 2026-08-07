# Security Policy

## Supported versions

| Version | Security fixes |
|---|---|
| `0.1.x` | Supported |
| Unreleased snapshots | Best effort |

真实 transcript detector 的兼容版本与安全修复版本是两回事。请同时查看 `plugins/tibo-hook/compatibility.json`，确认当前 Codex 版本是否允许真实检测。

## Reporting a vulnerability

请使用 GitHub 的 [private vulnerability reporting](https://github.com/zxdxjtu/tibo-hook/security/advisories/new) 提交安全问题。不要创建包含以下内容的公开 issue：

- SMTP password、token 或环境变量值；
- 真实邮箱、邮件正文或 `.eml`；
- transcript、prompt、assistant/tool 内容；
- 可用于复现真实账号额度或身份的信息。

报告中请尽量提供：受影响版本、平台、最小复现、预期影响以及已做的脱敏处理。项目维护者会先确认收到，再根据严重性协调修复和披露时间。

## Security boundaries

- `autoSend=false` 是默认安全边界；只有用户显式配置才允许 SMTP。
- 配置和模板是受信任的本机输入。能修改当前用户 `PLUGIN_DATA` 或进程环境的攻击者，已经进入本项目的本机信任边界。
- IPC 使用安装级随机密钥 HMAC；POSIX socket 和数据文件使用私有权限。Windows 依赖命名管道加 HMAC，并以当前用户 ACL 为 best effort。
- transcript parser 是 Experimental、版本门控且 fail closed；文本 429 永远不是触发依据。
- SMTP 使用证书和主机名验证，不提供关闭 TLS 校验的配置。
- 项目不声称抵御拥有同一系统用户、管理员、进程调试或磁盘读取权限的攻击者。

## Release checks

发布前运行：

```bash
npm ci
npm run verify
python3 /path/to/plugin-creator/scripts/validate_plugin.py plugins/tibo-hook
python3 /path/to/skill-creator/scripts/quick_validate.py plugins/tibo-hook/skills/tibo-hook-setup
```

同时检查 `npm pack --dry-run` 的文件清单，确保没有 `config.json`、`.eml`、outbox、日志、测试秘密或本机路径进入发布包。
