// Pure intent-matcher: tokenizes intent, scores keyword mappings by contiguous-sequence hits.
import { CATALOG_BY_NAME, type ToolEntry } from './catalog.js';
import { KEYWORD_MAPPINGS, type KeywordMapping } from './keywords.js';

// Letters/digits/hyphens; drops punctuation. `'what is "open interest"?'` → ['what','is','open','interest'].
export function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9-]+/g) ?? [];
}

// Contiguous run of tokens — avoids the 'open' inside 'open interest' substring false-positive.
export function containsTokenSequence(intentTokens: string[], keyword: string): boolean {
  const kwTokens = tokenize(keyword);
  if (kwTokens.length === 0) return false;
  outer: for (let i = 0; i + kwTokens.length <= intentTokens.length; i++) {
    for (let j = 0; j < kwTokens.length; j++) {
      if (intentTokens[i + j] !== kwTokens[j]) continue outer;
    }
    return true;
  }
  return false;
}

export interface MatchResult {
  tools: ToolEntry[];
  glossary: boolean;
}

export function matchTools(intent: string): MatchResult {
  const intentTokens = tokenize(intent);
  if (intentTokens.length === 0) return { tools: [], glossary: false };

  const scored: { mapping: KeywordMapping; score: number }[] = [];

  for (const mapping of KEYWORD_MAPPINGS) {
    let score = 0;
    for (const kw of mapping.keywords) {
      if (containsTokenSequence(intentTokens, kw)) {
        // +5 per extra token: 2-token hit beats 1-token but exact long phrase still wins over
        // 2-token coincidences.
        const kwTokenCount = tokenize(kw).length;
        score += kw.length + (kwTokenCount - 1) * 5;
      }
    }
    if (score > 0) {
      scored.push({ mapping, score });
    }
  }

  if (scored.length === 0) return { tools: [], glossary: false };

  scored.sort((a, b) => b.score - a.score);

  if (scored[0].mapping.glossary) {
    return { tools: [], glossary: true };
  }

  // Score-rank order, not catalog order (catalog order used to bury the winner).
  const seen = new Set<string>();
  const out: ToolEntry[] = [];
  for (const { mapping } of scored) {
    if (mapping.glossary) continue;
    for (const name of mapping.tools) {
      if (seen.has(name)) continue;
      const entry = CATALOG_BY_NAME.get(name);
      if (entry) {
        seen.add(name);
        out.push(entry);
      }
    }
  }
  return { tools: out, glossary: false };
}
