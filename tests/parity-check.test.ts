import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildReport,
  collectMcpNodeLists,
  collectUpstreamNodeLists,
  collectUpstreamRoutes,
  extractApiPaths,
  isAllowlist,
  normalizeDjangoRoute,
  parseUrlsModule,
  reachedRoutes,
  type UpstreamRoute,
} from '../scripts/parity-check-lib.js';

const ROOT_URLS = `
"""
URL configuration. Examples:
    path('', views.home, name='home')
    path('blog/', include('blog.urls'))
"""
from django.urls import include, path

urlpatterns = [
    path("", include("rbac.urls")),
    path("api/audit/token/", AuditTokenView.as_view(), name="audit_token"),
    path("api/", include("tables.urls")),
    path("ht/", include("health_check.urls")),
]
if settings.PLUGINS_ENABLED:
    urlpatterns.append(path("", include("plugins.urls")))
`;

const TABLES_URLS = `
router = DefaultRouter()
router.register(r"graphs", GraphViewSet, basename="graphs")
router.register(r"pythonnodes", PythonNodeViewSet)
# router.register(r"crewnodes", CrewNodeViewSet)

urlpatterns = [
    path("", include(router.urls)),
    path("run-session/test/", SessionTestRunView.as_view(), name="run-session-test"),
    path(
        "pythonnodes/<int:pk>/last-session-input/",
        PythonNodeLastTestInputView.as_view(),
    ),
    path(
        "naive-rag/<str:naive_rag_id>/document-configs/<int:pk>/",
        NaiveRagDocumentConfigViewSet.as_view({"get": "retrieve"}),
    ),
    path(
        "naive-rag/<str:naive_rag_id>/document-configs/bulk-update/",
        NaiveRagDocumentConfigViewSet.as_view({"put": "bulk_update"}),
    ),
    *[
        path(
            f"internal/sessions/<int:session_id>/tables/<int:table_id>/{operation}/",
            KeyValueRuntimeAPIView.as_view(),
        )
        for operation in ("read", "write")
    ],
]
`;

const RBAC_URLS = `
admin_router = DefaultRouter()
admin_router.register(r"organizations", OrganizationAdminViewSet, basename="admin-organization")
urlpatterns = [
    path("api/auth/login/", LoginView.as_view(), name="login"),
    path("api/admin/", include(admin_router.urls)),
]
`;

const REGISTRY = `
NODE_TYPE_REGISTRY: list[NodeTypeConfig] = [
    NodeTypeConfig(
        "python_node_list",
        PythonNode,
    ),
    NodeTypeConfig("graph_note_list", GraphNote),
]
`;

const GRAPH_NODES = `
class GraphData(BaseModel):
    graph_id: int | None = None
    python_node_list: list[PythonNodeData] = []
    edge_list: list[EdgeData] = []
    telegram_trigger_node_data_list: list[TelegramTriggerNodeData] = []

class SubGraphData(BaseModel):
    other_node_list: list[int] = []
`;

function route(path: string, kind: UpstreamRoute['kind'] = 'path'): UpstreamRoute {
  return { route: path, kind, source: 'urls.py' };
}

describe('parity check — upstream parsing', () => {
  let checkout: string;

  const write = (relativePath: string, content: string): void => {
    const file = join(checkout, relativePath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  };

  beforeEach(() => {
    checkout = mkdtempSync(join(tmpdir(), 'es-parity-'));
    write('src/django_app/django_app/urls.py', ROOT_URLS);
    write('src/django_app/tables/urls.py', TABLES_URLS);
    write('src/django_app/rbac/urls.py', RBAC_URLS);
    write('src/django_app/plugins/urls.py', 'urlpatterns = [path("api/plugins/available/", AvailablePluginsView.as_view())]');
    write('src/django_app/tables/services/graph_bulk_save_service/registry.py', REGISTRY);
    write('src/shared/models/graph_nodes.py', GRAPH_NODES);
  });

  afterEach(() => rmSync(checkout, { recursive: true, force: true }));

  it('follows include() from the root URLconf, keeps api/ routes and skips docstrings, comments and other prefixes', () => {
    const { routes, unresolvedModules } = collectUpstreamRoutes(checkout);

    expect(routes.map((item) => `${item.kind} ${item.route}`)).toEqual([
      'router admin/organizations/*',
      'path audit/token/',
      'path auth/login/',
      'router graphs/*',
      'path internal/sessions/{}/tables/{}/{}/',
      'path naive-rag/{}/document-configs/{}/',
      'path naive-rag/{}/document-configs/bulk-update/',
      'path plugins/available/',
      'path pythonnodes/{}/last-session-input/',
      'router pythonnodes/*',
      'path run-session/test/',
    ]);
    expect(unresolvedModules).toEqual(['health_check.urls']);
    expect(routes.find((item) => item.route === 'run-session/test/')?.source).toBe('src/django_app/tables/urls.py');
  });

  it('collects bulk-save registry keys and GraphData node lists (trigger data lists by their node-list name)', () => {
    expect(collectUpstreamNodeLists(checkout)).toEqual(['graph_note_list', 'python_node_list', 'telegram_trigger_node_list']);
  });

  it('normalizes Django converters, regex groups and f-string fields to {}', () => {
    expect(normalizeDjangoRoute('a/<int:pk>/b/<slug>/')).toBe('a/{}/b/{}/');
    expect(normalizeDjangoRoute('storage/recycle-bin/(?P<entry_id>\\d+)/contents')).toBe('storage/recycle-bin/{}/contents');
    expect(normalizeDjangoRoute('internal/{operation}/')).toBe('internal/{}/');
    expect(parseUrlsModule('urlpatterns = router.urls\nrouter = DefaultRouter()\nrouter.register(r"venvs", V)', 'api/', 'x').routes).toEqual([
      { route: 'api/venvs/*', kind: 'router', source: 'x' },
    ]);
  });
});

describe('parity check — MCP side and matching', () => {
  it('extracts API path literals, parameters from ${…}, and ignores prose and dynamic prefixes', () => {
    const source = [
      "// the node's code: 'not-a-path/'",
      "const a = this.client.get('graphs/');",
      'const b = this.client.post(`graphs/${graphId}/save/`, {});',
      "const c = { flow: 'labels/', tool: \"tool-labels/\" };",
      'const d = `${PATHS[kind]}import/`;',
      "const e = 'Hello, world/';",
      'const f = `${this.apiUrl}flows/${id}`;',
    ].join('\n');
    expect(extractApiPaths(source).sort()).toEqual(['graphs/', 'graphs/{}/save/', 'labels/', 'tool-labels/']);
  });

  it('a path reaches its best-agreeing route; a router prefix only through paths no route claims', () => {
    const routes = [
      route('naive-rag/{}/document-configs/{}/'),
      route('naive-rag/{}/document-configs/bulk-update/'),
      route('naive-rag/{}/'),
      route('naive-rag/suggest-search-params/'),
      route('pythonnodes/*', 'router'),
      route('pythonnodes/{}/last-session-input/'),
      route('graphs/*', 'router'),
    ];
    const reached = reachedRoutes(routes, [
      'naive-rag/{}/document-configs/bulk-update/',
      'naive-rag/{}/',
      'pythonnodes/{}/last-session-input/',
      'graphs/{}/save/',
    ]);
    expect([...reached].sort()).toEqual([
      'graphs/*',
      'naive-rag/{}/',
      'naive-rag/{}/document-configs/bulk-update/',
      'pythonnodes/{}/last-session-input/',
    ]);
  });

  it('reports gaps, allowlisted routes, stale allowlist entries and node-list drift in both directions', () => {
    const report = buildReport(
      [route('graphs/*', 'router'), route('edges/*', 'router'), route('notify/email/'), route('flow-assistants/{}/')],
      ['graphs/'],
      ['python_node_list', 'graph_note_list'],
      ['python_node_list', 'crew_node_list'],
      {
        routes: [
          { pattern: 'edges/*', category: 'per-node-crud', reason: 'bulk save' },
          { pattern: 'flow-assistants/*', category: 'flow-assistant', reason: 'unsupported' },
          { pattern: 'graphs/*', category: 'backlog', reason: 'now covered' },
          { pattern: 'gone/*', category: 'backlog', reason: 'removed upstream' },
        ],
        nodeLists: [{ name: 'graph_note_list', reason: 'notes are not written by MCP' }],
      },
    );

    expect(report.coveredRoutes).toEqual(['graphs/*']);
    expect(report.allowlistedRoutes).toEqual([
      { route: 'edges/*', category: 'per-node-crud' },
      { route: 'flow-assistants/{}/', category: 'flow-assistant' },
    ]);
    expect(report.gaps.map((gap) => gap.route)).toEqual(['notify/email/']);
    expect(report.staleCovered).toEqual(['graphs/*']);
    expect(report.staleUnmatched).toEqual(['gone/*']);
    expect(report.nodeLists.missingInMcp).toEqual([]);
    expect(report.nodeLists.unknownUpstream).toEqual(['crew_node_list']);
  });

  it('validates the allowlist shape and demands a reason', () => {
    expect(isAllowlist({ routes: [{ pattern: 'a/*', category: 'x', reason: 'why' }] })).toBe(true);
    expect(isAllowlist({ routes: [{ pattern: 'a/*', category: 'x', reason: ' ' }] })).toBe(false);
    expect(isAllowlist({ routes: [{ pattern: 'a/*' }] })).toBe(false);
    expect(isAllowlist({})).toBe(false);
  });

  it('reads the node lists push_flow sends from BulkSavePayload', () => {
    const lists = collectMcpNodeLists(resolve(__dirname, '..'));
    expect(lists).toContain('python_node_list');
    expect(lists).toContain('graph_note_list');
    expect(lists).not.toContain('edge_list');
  });
});
