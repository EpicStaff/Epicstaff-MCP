function unwrap(response) {
    return Array.isArray(response) ? response : response.results;
}
export class ToolsApi {
    client;
    constructor(client) {
        this.client = client;
    }
    async listBuiltinTools() {
        return unwrap(await this.client.get('tools/', { query: { limit: 1000 } }));
    }
    async listToolConfigs() {
        return unwrap(await this.client.get('tool-configs/', { query: { limit: 1000 } }));
    }
    async listPythonCodeTools() {
        return unwrap(await this.client.get('python-code-tool/', { query: { limit: 1000 } }));
    }
    async listMcpTools() {
        return unwrap(await this.client.get('mcp-tools/', { query: { limit: 1000 } }));
    }
    async createToolConfig(request) {
        return this.client.post('tool-configs/', { body: request });
    }
    async createPythonCodeTool(request) {
        return this.client.post('python-code-tool/', { body: request });
    }
    async updatePythonCodeTool(id, request) {
        return this.client.patch(`python-code-tool/${id}/`, { body: request });
    }
    async createMcpTool(request) {
        return this.client.post('mcp-tools/', { body: request });
    }
    async updateMcpTool(id, request) {
        return this.client.patch(`mcp-tools/${id}/`, { body: request });
    }
}
