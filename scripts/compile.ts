/**
 * Offline compiler CLI: `npm run compile -- <flow-dir> [--json]`.
 *
 * Runs the pure local pipeline (load → resolve → validate → emit → layout) and
 * prints the build report. No network, no credentials — the same thing the
 * `build_flow` / `validate_flow` MCP tools do. Exit code 1 if the flow has errors.
 */
import { resolve } from 'node:path';
import { compileFlow } from '../src/compiler/index.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const dir = args.find((arg) => !arg.startsWith('--'));
  if (!dir) {
    process.stderr.write('usage: npm run compile -- <flow-dir> [--json]\n');
    process.exit(2);
  }

  const artifact = await compileFlow(resolve(dir));
  const errors = artifact.diagnostics.filter((d) => d.severity === 'error');
  const warnings = artifact.diagnostics.filter((d) => d.severity === 'warning');

  if (json) {
    process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
    process.exit(errors.length > 0 ? 1 : 0);
  }

  process.stdout.write(`flow: ${artifact.flowName}\n`);

  if (artifact.entities.length > 0) {
    process.stdout.write('\nentities (push order):\n');
    for (const plan of artifact.entities) {
      process.stdout.write(`  ${plan.action.padEnd(17)} ${plan.kind.padEnd(20)} ${plan.key}\n`);
    }
  }

  if (artifact.graph.nodes.length > 0) {
    process.stdout.write(`\nnodes (${artifact.graph.nodes.length}), edges (${artifact.graph.edges.length}):\n`);
    for (const node of artifact.graph.nodes) {
      process.stdout.write(
        `  ${node.node_name.padEnd(20)} ${node.type.padEnd(30)} @ ${node.position.x},${node.position.y}\n`,
      );
    }
    const conditional = (artifact.summary.conditionalEdges as unknown[] | undefined) ?? [];
    if (conditional.length > 0) {
      process.stdout.write(`  conditional edges: ${conditional.length}\n`);
    }
  }

  for (const warning of warnings) {
    process.stdout.write(`\nwarning  ${warning.path}${warning.file ? ` (${warning.file})` : ''}\n         ${warning.message}\n`);
  }
  for (const error of errors) {
    process.stdout.write(`\nerror    ${error.path}${error.file ? ` (${error.file})` : ''}\n         ${error.message}\n`);
  }

  process.stdout.write(`\n${errors.length} error(s), ${warnings.length} warning(s)\n`);
  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
