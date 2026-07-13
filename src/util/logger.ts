/**
 * Stderr-only logger. Stdout is reserved for the MCP stdio transport —
 * writing anything else to it corrupts the protocol stream.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

function write(level: Level, message: string, detail?: unknown): void {
  const line = `[es-mcp] ${level.toUpperCase()} ${message}`;
  if (detail === undefined) {
    process.stderr.write(`${line}\n`);
  } else {
    const rendered = detail instanceof Error ? (detail.stack ?? detail.message) : JSON.stringify(detail);
    process.stderr.write(`${line} ${rendered}\n`);
  }
}

export const logger = {
  debug: (message: string, detail?: unknown) => write('debug', message, detail),
  info: (message: string, detail?: unknown) => write('info', message, detail),
  warn: (message: string, detail?: unknown) => write('warn', message, detail),
  error: (message: string, detail?: unknown) => write('error', message, detail),
};
