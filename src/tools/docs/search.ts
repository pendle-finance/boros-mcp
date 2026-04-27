// Scoring + excerpt extraction for `search_boros_docs`.
//
// Baseline: token-frequency scoring with a phrase-proximity bonus and a
// fixed-width excerpt window centered on the densest match.
//
// Trade-offs to revisit if quality is poor in practice:
//   - BM25-lite (TF normalized by sqrt(doc length)): would help if the long
//     gitbook page dominates the short overview page on every query just
//     because it has more total matches.
//   - IDF across DOC_SOURCES: down-weights words that appear in every doc
//     ("Boros", "market"). Worth it once we have ~5+ corpora.
//   - Embedding-based search: highest quality, requires a model + index. Not
//     worth pulling in for 4 documents.

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'does', 'for', 'from',
  'how', 'i', 'in', 'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or', 'that',
  'the', 'this', 'to', 'was', 'what', 'when', 'where', 'which', 'why', 'with',
  'you', 'your',
]);

const EXCERPT_RADIUS = 220;

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function queryTerms(query: string): string[] {
  const all = tokenize(query);
  const filtered = all.filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  return filtered.length > 0 ? filtered : all;
}

export interface ScoredDoc {
  score: number;
  excerpt: string;
}

export function scoreDoc(query: string, body: string): ScoredDoc | null {
  const terms = queryTerms(query);
  if (terms.length === 0 || body.length === 0) return null;

  const lower = body.toLowerCase();
  const positions: number[] = [];
  let tfScore = 0;

  for (const term of terms) {
    let from = 0;
    while (true) {
      const idx = lower.indexOf(term, from);
      if (idx < 0) break;
      positions.push(idx);
      tfScore += 1;
      from = idx + term.length;
    }
  }

  if (positions.length === 0) return null;

  // Phrase-proximity bonus: if the full query (joined) appears verbatim, big boost.
  const phrase = terms.join(' ');
  const phraseHits = lower.split(phrase).length - 1;
  const phraseBonus = phraseHits * Math.max(5, terms.length * 2);

  positions.sort((a, b) => a - b);
  const center = densestWindowCenter(positions, EXCERPT_RADIUS);
  const excerpt = sliceAround(body, center, EXCERPT_RADIUS);

  return {
    score: tfScore + phraseBonus,
    excerpt,
  };
}

function densestWindowCenter(positions: number[], radius: number): number {
  let best = positions[0];
  let bestCount = 1;
  let left = 0;
  for (let right = 0; right < positions.length; right++) {
    while (positions[right] - positions[left] > radius * 2) left++;
    const count = right - left + 1;
    if (count > bestCount) {
      bestCount = count;
      best = Math.floor((positions[left] + positions[right]) / 2);
    }
  }
  return best;
}

function sliceAround(body: string, center: number, radius: number): string {
  const start = Math.max(0, center - radius);
  const end = Math.min(body.length, center + radius);
  let chunk = body.slice(start, end).trim();
  if (start > 0) chunk = '… ' + chunk;
  if (end < body.length) chunk = chunk + ' …';
  return chunk.replace(/\s+/g, ' ');
}
