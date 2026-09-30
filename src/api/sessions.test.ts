import { describe, expect, it } from 'vitest';
import { summarizeMessages, type GraphMessage } from './sessions.js';

function msg(name: string, order: number, data: Record<string, unknown>): GraphMessage {
  return { id: order, session_id: 1, created_at: '', name, execution_order: order, message_data: data } as GraphMessage;
}

describe('summarizeMessages', () => {
  it('collapses the trace and surfaces the final reply from variables.reply', () => {
    const messages: GraphMessage[] = [
      msg('Price #1', 1, {
        message_type: 'python',
        python_code_execution_data: { returncode: 0, result_data: '{"total_eur": 120}' },
      }),
      msg('Compose #2', 2, {
        message_type: 'agent_node_stream',
        event: 'task_finish',
        data: { message: 'Hello! Your quote is 120 EUR.' },
      }),
      msg('__end__ #3', 3, {
        message_type: 'finish',
        state: { variables: { chat: { message: 'hi' }, reply: 'Hello! Your quote is 120 EUR.' } },
      }),
    ];

    const result = summarizeMessages(messages);
    expect(result.final_reply).toBe('Hello! Your quote is 120 EUR.');
    expect(result.count).toBe(2); // python_result + agent_reply (finish is not a timeline entry)
    expect(result.messages.map((m) => m.kind)).toEqual(['python_result', 'agent_reply']);
    expect(result.final_variables?.reply).toBe('Hello! Your quote is 120 EUR.');
  });

  it('reports a python error instead of a result', () => {
    const result = summarizeMessages([
      msg('Price #1', 1, {
        message_type: 'python',
        python_code_execution_data: { returncode: 1, stderr: 'boom' },
      }),
    ]);
    expect(result.messages[0]!.kind).toBe('python_result');
    expect(result.messages[0]!.detail).toContain('boom');
  });

  it('falls back to null reply when no terminal state carries one', () => {
    const result = summarizeMessages([
      msg('Compose #1', 1, { message_type: 'agent_node_stream', event: 'task_finish', data: { message: 'hi' } }),
    ]);
    expect(result.final_reply).toBeNull();
  });
});
