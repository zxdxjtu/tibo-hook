export const VERSION = typeof __TIBO_HOOK_VERSION__ === "string" ? __TIBO_HOOK_VERSION__ : "0.1.0";
export const PROTOCOL_VERSION = 1;
export const DEFAULT_SUBJECT = "Request for a Codex usage-limit review — {{requesterName}}";
export const DEFAULT_TEMPLATE = `Hi Tibo,

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
`;

declare const __TIBO_HOOK_VERSION__: string;
