/**
 * Security Event Logger
 * Provides structured logging for security-related events.
 */

export type SecurityEventType =
  | "auth_failure"
  | "rate_limit"
  | "auth_denied"
  | "validation_failure"
  | "suspicious_input";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface SecurityEvent {
  event: SecurityEventType;
  timestamp: string;
  ip?: string;
  api_key_prefix?: string;
  endpoint: string;
  reason: string;
  details?: Record<string, unknown>;
}

export interface SecurityLoggerDeps {
  output: (level: LogLevel, event: SecurityEvent) => void;
  minLevel?: LogLevel;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function createSecurityLogger(deps: SecurityLoggerDeps) {
  const minLevel = deps.minLevel ?? "info";

  function shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[minLevel];
  }

  function maskApiKey(apiKey: string): string {
    if (apiKey.length < 10) return "***";
    return `${apiKey.slice(0, 3)}...${apiKey.slice(-3)}`;
  }

  function log(level: LogLevel, event: Omit<SecurityEvent, "timestamp">) {
    if (!shouldLog(level)) return;

    const fullEvent: SecurityEvent = {
      ...event,
      timestamp: new Date().toISOString(),
    };
    deps.output(level, fullEvent);
  }

  return {
    authFailure(endpoint: string, reason: string, apiKey?: string, ip?: string) {
      log("warn", {
        event: "auth_failure",
        endpoint,
        reason,
        api_key_prefix: apiKey !== undefined ? maskApiKey(apiKey) : undefined,
        ip,
      });
    },

    rateLimit(endpoint: string, agentId: string, ip?: string) {
      log("warn", {
        event: "rate_limit",
        endpoint,
        reason: "rate_limit_exceeded",
        details: { agent_id: agentId },
        ip,
      });
    },

    authDenied(endpoint: string, reason: string, agentId: string) {
      log("warn", {
        event: "auth_denied",
        endpoint,
        reason,
        details: { agent_id: agentId },
      });
    },

    validationFailure(
      endpoint: string,
      reason: string,
      details?: Record<string, unknown>
    ) {
      log("info", {
        event: "validation_failure",
        endpoint,
        reason,
        details,
      });
    },

    suspiciousInput(
      endpoint: string,
      reason: string,
      details?: Record<string, unknown>
    ) {
      log("error", {
        event: "suspicious_input",
        endpoint,
        reason,
        details,
      });
    },
  };
}

// Default console logger for development
export const defaultSecurityLogger = createSecurityLogger({
  output: (level, event) => {
    const formatted = JSON.stringify(event);
    if (level === "error") console.error("[SECURITY]", formatted);
    else if (level === "warn") console.warn("[SECURITY]", formatted);
    else console.log("[SECURITY]", formatted);
  },
});
