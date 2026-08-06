export type Surface = "codex-app" | "codex-cli" | "unknown";
export type DetectorId = "transcript-experimental" | "debug-synthetic" | "app-server" | "turn-error-native";
export type DeliveryStatus = "reserved" | "accepted" | "rejected" | "unknown" | "drafted" | "suppressed";

export interface SmtpConfig {
  host: string;
  port: 587 | 465;
  security: "starttls-required" | "implicit-tls";
  username: string;
  fromEmail: string;
  passwordEnv: string;
  timeoutMs: number;
}

export interface Config {
  schemaVersion: 1;
  tiboEmail: string;
  userEmail: string;
  requesterName: string;
  useCase: string;
  impact: string;
  feedback: string;
  templatePath: string;
  subjectTemplate: string;
  autoSend: boolean;
  smtp?: SmtpConfig;
  debug: { triggerNextPrompt: boolean };
  policy: { maxPerRolling30Days: number };
}

export interface DetectedRateLimit {
  schemaVersion: 1;
  sessionId: string;
  turnId: string;
  occurredAt: string;
  surface: Surface;
  model: string;
  codexVersion: string;
  errorCode: "usage_limit_exceeded";
  limitKind: string | null;
  resetAt: string | null;
  detector: DetectorId;
}

export interface RateLimitEvent extends DetectedRateLimit {
  eventId: string;
  windowKey: string;
}

export interface TurnRegistration {
  protocolVersion: 1;
  sessionId: string;
  turnId: string;
  transcriptPath: string;
  fileIdentity: string;
  startOffset: number;
  model: string;
  codexVersion: string;
  surface: Surface;
  registeredAt: string;
}

export interface DeliveryRecord {
  sequence: number;
  eventIdHash: string;
  windowKey: string;
  status: DeliveryStatus;
  reservedAt: string;
  updatedAt: string;
  category?: string;
  draftName?: string;
}

export interface HookProjection {
  sessionId: string;
  turnId: string;
  transcriptPath: string;
  model: string;
}
