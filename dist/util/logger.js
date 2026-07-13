function write(level, message, detail) {
    const line = `[es-mcp] ${level.toUpperCase()} ${message}`;
    if (detail === undefined) {
        process.stderr.write(`${line}\n`);
    }
    else {
        const rendered = detail instanceof Error ? (detail.stack ?? detail.message) : JSON.stringify(detail);
        process.stderr.write(`${line} ${rendered}\n`);
    }
}
export const logger = {
    debug: (message, detail) => write('debug', message, detail),
    info: (message, detail) => write('info', message, detail),
    warn: (message, detail) => write('warn', message, detail),
    error: (message, detail) => write('error', message, detail),
};
