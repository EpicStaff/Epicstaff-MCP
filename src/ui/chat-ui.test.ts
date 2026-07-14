import { describe, expect, it } from 'vitest';
import { renderChatUi } from './chat-ui.js';

/** Pull the embedded `var ES_CONFIG = {...};` object back out of the generated page. */
function extractConfig(html: string): Record<string, unknown> {
  const match = html.match(/var ES_CONFIG = (\{[\s\S]*?\});/);
  if (!match) throw new Error('ES_CONFIG not found in generated HTML');
  return JSON.parse(match[1]!);
}

describe('renderChatUi', () => {
  const base = {
    apiUrl: 'http://localhost:8000/api/',
    graphId: 27,
    graphName: 'EU Pallet Shipping Quote Bot',
    orgId: 2,
    apiKey: 'SECRETKEY123',
  };

  it('embeds a round-trippable config with sensible defaults', () => {
    const config = extractConfig(renderChatUi(base));
    expect(config.graphId).toBe(27);
    expect(config.orgId).toBe(2);
    expect(config.apiKey).toBe('SECRETKEY123');
    // defaults
    expect(config.inputPath).toBe('chat.message');
    expect(config.replyPath).toBe('reply');
    expect(config.title).toBe('EU Pallet Shipping Quote Bot');
  });

  it('posts run input under the `variables` field, not `initial_state`', () => {
    const html = renderChatUi(base);
    expect(html).toContain("fd.append('variables'");
    expect(html).not.toContain("fd.append('initial_state'");
  });

  it('authenticates with the CORS-allowed ApiKey + org headers', () => {
    const html = renderChatUi(base);
    expect(html).toContain("'Authorization': 'ApiKey '");
    expect(html).toContain("'X-Organization-Id'");
  });

  it('honors custom paths and reset variables', () => {
    const config = extractConfig(
      renderChatUi({
        ...base,
        inputPath: 'input.text',
        replyPath: 'output.answer',
        resetVariables: { quote: {}, reply: null },
      }),
    );
    expect(config.inputPath).toBe('input.text');
    expect(config.replyPath).toBe('output.answer');
    expect(config.resetVariables).toEqual({ quote: {}, reply: null });
  });

  it('escapes the title in HTML tag contexts', () => {
    const html = renderChatUi({ ...base, title: '<img src=x onerror=alert(1)>' });
    // Both HTML uses (<title> and <h1>) are escaped...
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    // ...so no raw tag is injected into the markup.
    expect(html).not.toMatch(/<title><img/);
    expect(html).not.toMatch(/<h1><img/);
  });

  it('never lets an embedded string close the script tag early', () => {
    const html = renderChatUi({ ...base, welcome: 'end </script> tag' });
    // The literal closing tag must not appear inside the config payload.
    const configLine = html.match(/var ES_CONFIG = .*/)![0];
    expect(configLine).not.toContain('</script>');
  });
});
