import { connect } from './lib.mjs';
const context = await connect();
for (const id of process.argv.slice(2).map(Number)) {
  const g = await context.client.get<any>(`graphs/${id}/`);
  console.log(`\n===== graph #${id} "${g.name}" =====`);
  const nodeName = (uuid: string): string => {
    for (const key of Object.keys(g)) {
      if (!key.endsWith('_list') && !Array.isArray(g[key])) continue;
      const arr = g[key];
      if (!Array.isArray(arr)) continue;
      const hit = arr.find((n: any) => n && (n.node_name !== undefined) && (n.id === uuid || n.node_id === uuid));
      if (hit) return `${hit.node_name}`;
    }
    return uuid?.slice?.(0, 8) ?? String(uuid);
  };
  // Dump every *_node_list with node_name + id
  for (const key of Object.keys(g)) {
    const arr = g[key];
    if (Array.isArray(arr) && key.includes('node') && arr.length && arr[0]?.node_name !== undefined) {
      console.log(`  ${key}:`, arr.map((n: any) => `${n.node_name}(${n.id})`).join(', '));
    }
  }
  console.log('  entrypoint / start:', JSON.stringify(g.start_node_list?.map((s: any) => ({ id: s.id, vars: Object.keys(s.variables ?? {}) }))));
  console.log('  edges:', JSON.stringify((g.edge_list ?? g.edges ?? []).map((e: any) => ({ start: e.start_key ?? e.start_node ?? e.source, end: e.end_key ?? e.end_node ?? e.target }))));
  const cond = g.conditional_edge_list ?? g.conditionaledge_list ?? g.conditional_edges ?? [];
  console.log('  conditional_edges:', JSON.stringify(cond.map((c: any) => ({ source: c.source_node ?? c.start_key ?? c.node, then: c.then_key, keys: Object.keys(c) }))));
  const dt = g.decision_table_node_list ?? [];
  for (const d of dt) {
    console.log(`  decision-table ${d.node_name} condition_groups:`, JSON.stringify(d.condition_groups ?? d.table?.condition_groups));
  }
}
