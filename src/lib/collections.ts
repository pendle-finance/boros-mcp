export interface FilterCondition {
  field: string;
  op: '=' | '!=' | '>' | '<' | '>=' | '<=' | 'LIKE';
  value: string | number;
}

export function applyFilters<T extends Record<string, unknown>>(items: T[], filters?: FilterCondition[]): T[] {
  if (!filters || filters.length === 0) return items;
  return items.filter(item => {
    return filters.every(f => {
      const fieldValue = item[f.field];
      if (fieldValue === undefined) return false;

      if (f.op === 'LIKE') {
        // Strip outer SQL %/_ wildcards — engine is .includes, not LIKE; raw `%ETH%` would match nothing.
        const needle = String(f.value).toLowerCase().replace(/^[%_]+|[%_]+$/g, '');
        return String(fieldValue).toLowerCase().includes(needle);
      }

      const numField = Number(fieldValue);
      const numValue = Number(f.value);
      const useNumeric = !isNaN(numField) && !isNaN(numValue);

      switch (f.op) {
        case '=': return useNumeric ? numField === numValue : String(fieldValue) === String(f.value);
        case '!=': return useNumeric ? numField !== numValue : String(fieldValue) !== String(f.value);
        case '>': return useNumeric && numField > numValue;
        case '<': return useNumeric && numField < numValue;
        case '>=': return useNumeric && numField >= numValue;
        case '<=': return useNumeric && numField <= numValue;
        default: return true;
      }
    });
  });
}

export function applySort<T extends Record<string, unknown>>(items: T[], sort?: { field: string; direction: 'asc' | 'desc' }): T[] {
  if (!sort) return items;
  return [...items].sort((a, b) => {
    const aVal = Number(a[sort.field] ?? 0);
    const bVal = Number(b[sort.field] ?? 0);
    return sort.direction === 'asc' ? aVal - bVal : bVal - aVal;
  });
}

// Markets list <150 @ 100/page → 50 is 3x headroom; guards against repeated-resumeToken loops.
export const MAX_PAGINATION_PAGES = 50;

export async function paginate<T>(
  fetchPage: (resumeToken: string | undefined) => Promise<{ results?: T[]; resumeToken?: string | null }>,
  opts?: { maxPages?: number; label?: string },
): Promise<T[]> {
  const maxPages = opts?.maxPages ?? MAX_PAGINATION_PAGES;
  const out: T[] = [];
  const seen = new Set<string>();
  let resumeToken: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchPage(resumeToken);
    out.push(...(res.results ?? []));
    const next = res.resumeToken ?? undefined;
    if (!next) return out;
    if (seen.has(next)) {
      throw new Error(`${opts?.label ?? 'paginate'}: server returned repeated resumeToken — aborting to prevent infinite loop`);
    }
    seen.add(next);
    resumeToken = next;
  }
  throw new Error(`${opts?.label ?? 'paginate'}: exceeded ${maxPages} pages — aborting`);
}

/** Variadic sum of decimal-string bigints. Returns undefined if nothing parsed (vs. all-zero). */
export function sumBigStrings(...xs: (string | undefined | null)[]): string | undefined {
  let acc = 0n;
  let any = false;
  for (const x of xs) {
    if (x === undefined || x === null) continue;
    try { acc += BigInt(x); any = true; } catch { /* skip non-bigint inputs */ }
  }
  return any ? acc.toString() : undefined;
}

/** Always returns bigint (even on empty). Use sumBigStrings when "no inputs" must differ from zero. */
export function sumBigInts(xs: (string | undefined)[]): bigint {
  return xs.reduce<bigint>((acc, v) => acc + (v ? BigInt(v) : 0n), 0n);
}
