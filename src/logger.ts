export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  readonly service: string;
  readonly environment: string;
  readonly level: LogLevel;
  readonly sink?: (level: LogLevel, line: string) => void;
}

export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly code?: string | number;
  readonly status?: number;
  readonly method?: string;
  readonly route?: string;
  readonly syscall?: string;
  readonly path?: string;
  readonly stack?: string;
  readonly cause?: SerializedError | string;
}

const MAX_CAUSE_DEPTH = 3;

// Interaction and webhook URLs embed a bearer token as the path segment after the ID.
const TOKEN_IN_PATH = /\/(interactions|webhooks)\/(\d+)\/[^/]+/g;

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

export function redactRoute(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url.split("?")[0] ?? "";
  }
  return pathname.replace(TOKEN_IN_PATH, "/$1/$2/[redacted]");
}

// Keeps the fields that explain a failure: Discord REST errors carry code/status/method/url
// (code 50013 is "Missing Permissions", 50001 "Missing Access"), Node system errors carry
// code/syscall/path (for example ENOENT when yt-dlp or ffmpeg is missing).
export function serializeError(error: Error, depth = 0): SerializedError {
  const extra = error as Error & Record<string, unknown>;
  const { code, status, method, url, syscall, path } = extra;
  let cause: SerializedError | string | undefined;
  if (error.cause instanceof Error && depth < MAX_CAUSE_DEPTH) {
    cause = serializeError(error.cause, depth + 1);
  } else if (error.cause !== undefined && !(error.cause instanceof Error)) {
    cause = String(error.cause);
  }
  return {
    name: error.name,
    message: error.message,
    ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
    ...(typeof status === "number" ? { status } : {}),
    ...(typeof method === "string" ? { method } : {}),
    ...(typeof url === "string" ? { route: redactRoute(url) } : {}),
    ...(typeof syscall === "string" ? { syscall } : {}),
    ...(typeof path === "string" ? { path } : {}),
    ...(error.stack === undefined ? {} : { stack: error.stack }),
    ...(cause === undefined ? {} : { cause }),
  };
}

function defaultSink(level: LogLevel, line: string): void {
  if (level === "error" || level === "warn") {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
}

export function createLogger(options: LoggerOptions): Logger {
  const { service, environment, sink = defaultSink } = options;
  const threshold = LOG_LEVELS.indexOf(options.level);
  const write = (level: LogLevel, message: string, fields: LogFields = {}): void => {
    if (LOG_LEVELS.indexOf(level) < threshold) {
      return;
    }
    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      severity: level,
      message,
      service,
      environment,
    };
    for (const [key, value] of Object.entries(fields)) {
      entry[key] = key === "error" && value instanceof Error ? serializeError(value) : value;
    }
    sink(level, `${JSON.stringify(entry)}\n`);
  };
  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
}
