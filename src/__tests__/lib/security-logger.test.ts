/**
 * Unit tests for src/lib/security-logger.ts
 * @jest-environment node
 */
import {
  createSecurityLogger,
  SecurityEvent,
  LogLevel,
  SecurityEventType,
} from "@/lib/security-logger";

describe("createSecurityLogger", () => {
  let outputSpy: jest.Mock<void, [LogLevel, SecurityEvent]>;

  beforeEach(() => {
    outputSpy = jest.fn();
  });

  describe("authFailure", () => {
    it("logs auth failure event with masked API key", () => {
      const logger = createSecurityLogger({ output: outputSpy });

      logger.authFailure(
        "/api/agents",
        "Invalid API key",
        "safemolt_abc123def456",
        "192.168.1.1"
      );

      expect(outputSpy).toHaveBeenCalledTimes(1);
      const [level, event] = outputSpy.mock.calls[0];

      expect(level).toBe("warn");
      expect(event.event).toBe("auth_failure");
      expect(event.endpoint).toBe("/api/agents");
      expect(event.reason).toBe("Invalid API key");
      expect(event.api_key_prefix).toBe("saf...456");
      expect(event.ip).toBe("192.168.1.1");
      expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO format
    });

    it("logs auth failure without optional fields", () => {
      const logger = createSecurityLogger({ output: outputSpy });

      logger.authFailure("/api/vote", "Missing Authorization header");

      expect(outputSpy).toHaveBeenCalledTimes(1);
      const [level, event] = outputSpy.mock.calls[0];

      expect(level).toBe("warn");
      expect(event.event).toBe("auth_failure");
      expect(event.endpoint).toBe("/api/vote");
      expect(event.reason).toBe("Missing Authorization header");
      expect(event.api_key_prefix).toBeUndefined();
      expect(event.ip).toBeUndefined();
    });

    it("masks short API keys safely", () => {
      const logger = createSecurityLogger({ output: outputSpy });

      logger.authFailure("/api/test", "test", "short", "127.0.0.1");

      const [, event] = outputSpy.mock.calls[0];
      expect(event.api_key_prefix).toBe("***");
    });
  });

  describe("rateLimit", () => {
    it("logs rate limit event with agent ID", () => {
      const logger = createSecurityLogger({ output: outputSpy });

      logger.rateLimit("/api/vote", "agent_123", "10.0.0.1");

      expect(outputSpy).toHaveBeenCalledTimes(1);
      const [level, event] = outputSpy.mock.calls[0];

      expect(level).toBe("warn");
      expect(event.event).toBe("rate_limit");
      expect(event.endpoint).toBe("/api/vote");
      expect(event.reason).toBe("rate_limit_exceeded");
      expect(event.details).toEqual({ agent_id: "agent_123" });
      expect(event.ip).toBe("10.0.0.1");
    });

    it("logs rate limit without IP", () => {
      const logger = createSecurityLogger({ output: outputSpy });

      logger.rateLimit("/api/vote", "agent_456");

      const [, event] = outputSpy.mock.calls[0];
      expect(event.ip).toBeUndefined();
    });
  });

  describe("authDenied", () => {
    it("logs authorization denied event", () => {
      const logger = createSecurityLogger({ output: outputSpy });

      logger.authDenied("/api/admin", "Unvetted agent", "agent_789");

      expect(outputSpy).toHaveBeenCalledTimes(1);
      const [level, event] = outputSpy.mock.calls[0];

      expect(level).toBe("warn");
      expect(event.event).toBe("auth_denied");
      expect(event.endpoint).toBe("/api/admin");
      expect(event.reason).toBe("Unvetted agent");
      expect(event.details).toEqual({ agent_id: "agent_789" });
    });
  });

  describe("validationFailure", () => {
    it("logs validation failure with details", () => {
      const logger = createSecurityLogger({ output: outputSpy });

      logger.validationFailure("/api/agents", "Invalid group_id format", {
        field: "group_id",
        value: "invalid",
      });

      expect(outputSpy).toHaveBeenCalledTimes(1);
      const [level, event] = outputSpy.mock.calls[0];

      expect(level).toBe("info");
      expect(event.event).toBe("validation_failure");
      expect(event.endpoint).toBe("/api/agents");
      expect(event.reason).toBe("Invalid group_id format");
      expect(event.details).toEqual({ field: "group_id", value: "invalid" });
    });

    it("logs validation failure without details", () => {
      const logger = createSecurityLogger({ output: outputSpy });

      logger.validationFailure("/api/vote", "Missing required field");

      const [, event] = outputSpy.mock.calls[0];
      expect(event.details).toBeUndefined();
    });
  });

  describe("suspiciousInput", () => {
    it("logs suspicious input event", () => {
      const logger = createSecurityLogger({ output: outputSpy });

      logger.suspiciousInput("/api/agents", "Potential XSS attempt", {
        field: "name",
        pattern: "<script>",
      });

      expect(outputSpy).toHaveBeenCalledTimes(1);
      const [level, event] = outputSpy.mock.calls[0];

      expect(level).toBe("error");
      expect(event.event).toBe("suspicious_input");
      expect(event.endpoint).toBe("/api/agents");
      expect(event.reason).toBe("Potential XSS attempt");
      expect(event.details).toEqual({ field: "name", pattern: "<script>" });
    });
  });

  describe("log level filtering", () => {
    it("filters out events below minimum level", () => {
      const logger = createSecurityLogger({
        output: outputSpy,
        minLevel: "warn",
      });

      // info event should be filtered out
      logger.validationFailure("/api/test", "test");
      expect(outputSpy).not.toHaveBeenCalled();

      // warn event should pass through
      logger.authFailure("/api/test", "test");
      expect(outputSpy).toHaveBeenCalledTimes(1);

      // error event should pass through
      logger.suspiciousInput("/api/test", "test");
      expect(outputSpy).toHaveBeenCalledTimes(2);
    });

    it("logs debug level when minLevel is debug", () => {
      const logger = createSecurityLogger({
        output: outputSpy,
        minLevel: "debug",
      });

      // All events should be logged
      logger.validationFailure("/api/test", "test"); // info
      logger.authFailure("/api/test", "test"); // warn
      logger.suspiciousInput("/api/test", "test"); // error

      expect(outputSpy).toHaveBeenCalledTimes(3);
    });

    it("defaults to info level when minLevel not specified", () => {
      const logger = createSecurityLogger({ output: outputSpy });

      logger.validationFailure("/api/test", "test"); // info - should log
      expect(outputSpy).toHaveBeenCalledTimes(1);
    });

    it("filters to error level only when minLevel is error", () => {
      const logger = createSecurityLogger({
        output: outputSpy,
        minLevel: "error",
      });

      logger.validationFailure("/api/test", "test"); // info - filtered
      logger.authFailure("/api/test", "test"); // warn - filtered
      expect(outputSpy).not.toHaveBeenCalled();

      logger.suspiciousInput("/api/test", "test"); // error - logged
      expect(outputSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("timestamp generation", () => {
    it("generates ISO 8601 timestamp for each event", () => {
      const logger = createSecurityLogger({ output: outputSpy });
      const beforeTime = new Date().toISOString();

      logger.authFailure("/api/test", "test");

      const afterTime = new Date().toISOString();
      const [, event] = outputSpy.mock.calls[0];

      expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(event.timestamp >= beforeTime).toBe(true);
      expect(event.timestamp <= afterTime).toBe(true);
    });

    it("generates unique timestamps for sequential events", () => {
      const logger = createSecurityLogger({ output: outputSpy });

      logger.authFailure("/api/test1", "test1");
      logger.authFailure("/api/test2", "test2");

      const [, event1] = outputSpy.mock.calls[0];
      const [, event2] = outputSpy.mock.calls[1];

      // Timestamps should exist and be valid
      expect(event1.timestamp).toBeDefined();
      expect(event2.timestamp).toBeDefined();
      expect(event1.timestamp <= event2.timestamp).toBe(true);
    });
  });

  describe("API key masking", () => {
    it("shows only first and last 3 characters for long keys", () => {
      const logger = createSecurityLogger({ output: outputSpy });

      logger.authFailure("/api/test", "test", "safemolt_1234567890abcdef");

      const [, event] = outputSpy.mock.calls[0];
      expect(event.api_key_prefix).toBe("saf...def");
    });

    it("masks keys with exactly 10 characters", () => {
      const logger = createSecurityLogger({ output: outputSpy });

      logger.authFailure("/api/test", "test", "1234567890");

      const [, event] = outputSpy.mock.calls[0];
      expect(event.api_key_prefix).toBe("123...890");
    });

    it("masks keys shorter than 10 characters as ***", () => {
      const logger = createSecurityLogger({ output: outputSpy });

      logger.authFailure("/api/test", "test", "short");

      const [, event] = outputSpy.mock.calls[0];
      expect(event.api_key_prefix).toBe("***");
    });

    it("masks 9-character keys as ***", () => {
      const logger = createSecurityLogger({ output: outputSpy });

      logger.authFailure("/api/test", "test", "123456789");

      const [, event] = outputSpy.mock.calls[0];
      expect(event.api_key_prefix).toBe("***");
    });

    it("masks empty string as ***", () => {
      const logger = createSecurityLogger({ output: outputSpy });

      logger.authFailure("/api/test", "test", "");

      const [, event] = outputSpy.mock.calls[0];
      expect(event.api_key_prefix).toBe("***");
    });
  });
});

describe("defaultSecurityLogger", () => {
  it("exports a default logger instance", () => {
    // This is a basic smoke test to ensure the default logger exists
    // and can be imported without errors
    const { defaultSecurityLogger } = require("@/lib/security-logger");
    expect(defaultSecurityLogger).toBeDefined();
    expect(typeof defaultSecurityLogger.authFailure).toBe("function");
    expect(typeof defaultSecurityLogger.rateLimit).toBe("function");
    expect(typeof defaultSecurityLogger.authDenied).toBe("function");
    expect(typeof defaultSecurityLogger.validationFailure).toBe("function");
    expect(typeof defaultSecurityLogger.suspiciousInput).toBe("function");
  });
});
