import { z } from 'zod';
const envSchema = z.object({
    ES_URL: z
        .string()
        .url('ES_URL must be a valid URL, e.g. http://127.0.0.1')
        .transform(normalizeApiUrl),
    ES_EMAIL: z.string().email('ES_EMAIL must be a valid email address'),
    ES_PASSWORD: z.string().min(1, 'ES_PASSWORD must not be empty'),
});
/**
 * Normalize any user-supplied EpicStaff URL to the frontend convention:
 * a base URL ending in `/api/`, so callers concatenate `resource/` directly.
 * Accepts `http://host`, `http://host/`, `http://host/api`, `http://host/api/`.
 */
function normalizeApiUrl(raw) {
    let url = raw.replace(/\/+$/, '');
    if (!url.endsWith('/api')) {
        url = `${url}/api`;
    }
    return `${url}/`;
}
export function loadConfig(env = process.env) {
    const parsed = envSchema.safeParse({
        ES_URL: env.ES_URL,
        ES_EMAIL: env.ES_EMAIL,
        ES_PASSWORD: env.ES_PASSWORD,
    });
    if (!parsed.success) {
        const problems = parsed.error.issues
            .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
            .join('; ');
        throw new Error(`Invalid EpicStaff MCP configuration — ${problems}. ` +
            'Set ES_URL, ES_EMAIL and ES_PASSWORD in the MCP server environment.');
    }
    return {
        apiUrl: parsed.data.ES_URL,
        email: parsed.data.ES_EMAIL,
        password: parsed.data.ES_PASSWORD,
    };
}
