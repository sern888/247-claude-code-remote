/**
 * Structured logger for the 247 web application.
 * In development: logs to console with prefixes
 * In production: can be extended to send to external logging service
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
  [key: string]: unknown;
}

const isDevelopment = process.env.NODE_ENV === 'development';

function formatMessage(
  level: LogLevel,
  tag: string,
  message: string,
  context?: LogContext
): string {
  const timestamp = new Date().toISOString();
  const contextStr = context ? ` ${JSON.stringify(context)}` : '';
  return `[${timestamp}] [${level.toUpperCase()}] [${tag}] ${message}${contextStr}`;
}

function shouldLog(level: LogLevel): boolean {
  // In production, only log warnings and errors
  if (!isDevelopment && (level === 'debug' || level === 'info')) {
    return false;
  }
  return true;
}

/**
 * The single place where log lines reach the console. Application code goes
 * through createLogger instead of calling console.debug/info itself.
 */
function writeToConsole(level: LogLevel, line: string): void {
  // eslint-disable-next-line no-console -- this is the logging sink: every logger method ends up here
  console[level](line);
}

function describeError(error: unknown, context?: LogContext): LogContext {
  return error instanceof Error
    ? { ...context, errorMessage: error.message, stack: error.stack }
    : { ...context, error };
}

/**
 * Creates a scoped logger with a specific tag prefix.
 * Example: const log = createLogger('WS');
 */
export function createLogger(tag: string) {
  const log = (level: LogLevel, message: string, context?: LogContext) => {
    if (shouldLog(level)) {
      writeToConsole(level, formatMessage(level, tag, message, context));
    }
  };

  return {
    debug(message: string, context?: LogContext) {
      log('debug', message, context);
    },
    info(message: string, context?: LogContext) {
      log('info', message, context);
    },
    warn(message: string, context?: LogContext) {
      log('warn', message, context);
    },
    error(message: string, error?: unknown, context?: LogContext) {
      log('error', message, describeError(error, context));
    },
  };
}

// Pre-configured loggers for common use cases
export const wsLogger = createLogger('WS');
export const pollingLogger = createLogger('Polling');
export const pushLogger = createLogger('Push');
export const deeplinkLogger = createLogger('Deeplink');
export const terminalLogger = createLogger('Terminal');
export const archivedLogger = createLogger('Archived');
