// Compact stringify — pretty-print is a 30-40% token tax. BOROS_MCP_PRETTY=1 for debug.
const PRETTY_JSON = process.env.BOROS_MCP_PRETTY === '1';

export function jsonResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: PRETTY_JSON ? JSON.stringify(data, null, 2) : JSON.stringify(data) }],
  };
}
