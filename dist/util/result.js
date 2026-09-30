export function ok(data) {
    return { ok: true, data };
}
export function err(error, options = {}) {
    return { ok: false, error, ...options };
}
/** Render a ToolResult as MCP tool-call content. */
export function toContent(result) {
    return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        ...(result.ok ? {} : { isError: true }),
    };
}
