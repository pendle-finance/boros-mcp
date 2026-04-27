import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { jsonResult } from '../../utils.js';
import { catchToErrorContent } from '../../agent/errors.js';
import { DOC_SOURCES, DOC_SOURCE_IDS, type DocSource } from './sources.js';
import { fetchDoc } from './fetcher.js';
import { scoreDoc } from './search.js';

interface SuccessfulHit {
  src: DocSource;
  score: number;
  excerpt: string;
}

interface FetchFailure {
  src: DocSource;
  error: string;
}

export function registerDocsTool(server: McpServer): void {
  server.registerTool(
    'search_boros_docs',
    {
      annotations: { readOnlyHint: true, openWorldHint: true },
      description:
        'Search the public Boros documentation (GitBook user docs, developer docs, OpenAPI reference) for FAQ-style answers. ' +
        'Use this for conceptual questions like "how does cross margin work", "what is implied APR", "how do I become a maker", "what does tickStep mean". ' +
        'Fetches curated URLs on demand (cached 30 min) and returns the most relevant excerpts with their source URL. ' +
        'Always cite the returned `url` so the user can verify — excerpts are auto-extracted snippets, not authoritative. ' +
        'Do NOT use for live state (positions, balances, prices, orderbook) — those have dedicated tools.',
      inputSchema: {
        query: z
          .string()
          .trim()
          .min(2, 'query too short')
          .max(300, 'query too long')
          .describe('Free-form question, e.g. "how does cross margin work" or "what does tickStep mean".'),
        sources: z
          .array(z.enum(DOC_SOURCE_IDS))
          .optional()
          .describe(
            `Restrict search to specific source ids. Available: ${DOC_SOURCES.map((s) => `${s.id} (${s.label})`).join(', ')}. Default: all.`,
          ),
        limit: z.number().int().min(1).max(8).default(3).describe('Max excerpts to return. Default 3.'),
      },
    },
    async ({ query, sources, limit }) => {
      try {
        const selected = sources && sources.length > 0
          ? DOC_SOURCES.filter((s) => sources.includes(s.id))
          : DOC_SOURCES;

        const fetched = await Promise.all(
          selected.map(async (src): Promise<{ src: DocSource; text: string } | FetchFailure> => {
            try {
              const text = await fetchDoc(src.url);
              return { src, text };
            } catch (err) {
              return { src, error: (err as Error).message };
            }
          }),
        );

        const successes: SuccessfulHit[] = [];
        const failures: FetchFailure[] = [];

        for (const item of fetched) {
          if ('error' in item) {
            failures.push(item);
            continue;
          }
          const scored = scoreDoc(query, item.text);
          if (!scored) continue;
          successes.push({ src: item.src, score: scored.score, excerpt: scored.excerpt });
        }

        successes.sort((a, b) => b.score - a.score);
        const top = successes.slice(0, limit);

        const response: Record<string, unknown> = {
          query,
          results: top.map((r) => ({
            source: r.src.id,
            label: r.src.label,
            url: r.src.url,
            score: r.score,
            excerpt: r.excerpt,
          })),
          totalMatches: successes.length,
          searchedSources: selected.map((s) => s.id),
        };

        if (failures.length > 0) {
          response.fetchErrors = failures.map((f) => ({
            source: f.src.id,
            url: f.src.url,
            error: f.error,
          }));
        }

        if (top.length === 0) {
          response.hint =
            'No matches. Try shorter, more concrete query terms (e.g. "tickStep" instead of "what is the tickStep parameter for"). For live trading state, use the dedicated tools instead.';
        } else {
          response._context = {
            note: 'Excerpts are auto-extracted snippets — cite the `url` so the user can verify. Cache TTL is 30 min; pages may have changed since the snapshot.',
          };
        }

        return jsonResult(response);
      } catch (err) {
        return catchToErrorContent(err);
      }
    },
  );
}
