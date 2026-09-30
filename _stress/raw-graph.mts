import { connect } from './lib.mjs';
const context = await connect();
for (const id of process.argv.slice(2).map(Number)) {
  const g = await context.client.get<any>(`graphs/${id}/`);
  console.log(`\n===== graph #${id} "${g.name}" entrypoint=${JSON.stringify(g.entrypoint)} =====`);
  const idToName: Record<number, string> = {};
  for (const key of Object.keys(g)) {
    const arr = g[key];
    if (Array.isArray(arr)) for (const n of arr) if (n && n.node_name !== undefined && n.id !== undefined) idToName[n.id] = n.node_name;
  }
  console.log('nodes:', JSON.stringify(idToName));
  console.log('EDGES raw:', JSON.stringify(g.edge_list ?? g.edges, null, 0));
  console.log('CONDITIONAL raw:', JSON.stringify(g.conditional_edge_list ?? g.conditional_edges, null, 0));
  for (const d of g.decision_table_node_list ?? []) {
    console.log(`DT ${d.node_name}:`, JSON.stringify({ default_next_node: d.default_next_node, next_error_node: d.next_error_node, condition_groups: d.condition_groups }));
  }
}
