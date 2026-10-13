export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

function serializeError(error: unknown): unknown {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return error;
}

export function createLogger(service: string, environment: string): Logger {
  const write = (level: LogLevel, message: string, fields: LogFields = {}): void => {
    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      severity: level,
      message,
      service,
      environment,
    };
    for (const [key, value] of Object.entries(fields)) {
      entry[key] = key === "error" ? serializeError(value) : value;
    }
    const line = `${JSON.stringify(entry)}\n`;
    if (level === "error" || level === "warn") {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }
  };
  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
}
