---
name: tibo-hook-setup
description: Configure and operate the local tibo-hook Codex plugin. Use when a user asks to initialize tibo-hook, locate or validate its configuration, edit or preview its request template, arm the one-shot debug preview, run the explicit SMTP self-test, or inspect privacy-safe delivery status.
---

# Tibo Hook Setup

Operate the plugin through its bundled runtime. Resolve the plugin root from this skill directory by moving up twice (`tibo-hook-setup` → `skills` → plugin root). Run `node <plugin-root>/dist/tibo-hook.cjs <command>`. Preserve the current process environment so `TIBO_HOOK_PLUGIN_DATA` and the configured SMTP password environment variable remain available.

## Safe workflow

1. Run `init`. Report every created path. Never overwrite an existing configuration or template.
2. Run `config path`, then ask the user to fill `tiboEmail`, `userEmail`, `requesterName`, `useCase`, `impact`, and `feedback` with truthful values. Never discover or invent Tibo's address.
3. Run `validate`. Fix only configuration errors the user authorizes. Never place an SMTP password in `config.json`.
4. Run `preview` and give the user the local `.eml` path. Do not enable `autoSend` on the user's behalf.
5. Use `debug-next` only when requested. Explain that it affects the next prompt once, generates a self-addressed preview, never connects to SMTP, and does not consume the 30-day quota.
6. Run `smtp-test --to-self` only with explicit authorization because it sends an external email. Do not accept or simulate another destination.
7. Run `status` to report sanitized state. Do not print config contents, complete email addresses, template bodies, transcript text, or environment values.

## Command contract

- `init`: create missing data files and installation keys.
- `config path`: print the configuration and template paths.
- `validate`: perform read-only checks with no SMTP connection.
- `preview`: create a local preview addressed to the configured user email.
- `debug-next`: atomically arm a one-shot synthetic preview.
- `smtp-test --to-self`: explicitly send a fixed self-test message.
- `status`: show supervisor health and recent sanitized delivery records.

If the runtime cannot locate installed plugin data, set `TIBO_HOOK_PLUGIN_DATA` to the exact `PLUGIN_DATA` directory supplied by Codex. Do not guess among multiple installations.
