import { z } from 'zod';

export const INCLUDE_ALL = 'all' as const;

// Returns the set of keys that should appear on the output record.
// - spec undefined / empty → defaults only
// - spec contains "all" → defaults ∪ optional
// - otherwise → defaults ∪ (spec ∩ optional). Unknown keys in spec already rejected by Zod enum.
export function buildIncludeSet(
  spec: readonly string[] | undefined,
  defaults: readonly string[],
  optional: readonly string[],
): Set<string> {
  const out = new Set<string>(defaults);
  if (!spec || spec.length === 0) return out;
  if (spec.includes(INCLUDE_ALL)) {
    for (const f of optional) out.add(f);
    return out;
  }
  for (const f of spec) if (f !== INCLUDE_ALL) out.add(f);
  return out;
}

// Drop keys not in `fields`. Preserves the original key order of `obj` so output stays stable.
export function projectFields<T extends Record<string, unknown>>(
  obj: T,
  fields: ReadonlySet<string>,
): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) {
    if (fields.has(k)) out[k] = obj[k];
  }
  return out as Partial<T>;
}

// Same as projectFields but with `always` keys that bypass the include filter (e.g. global notes
// like `apr`, `amounts` that aren't tied to a single field). Returns {} if no key matches.
export function projectContext<T extends Record<string, unknown>>(
  ctx: T,
  fields: ReadonlySet<string>,
  always?: readonly (keyof T & string)[],
): Partial<T> {
  const out: Record<string, unknown> = {};
  const keep = new Set<string>(fields);
  if (always) for (const k of always) keep.add(k);
  for (const k of Object.keys(ctx)) {
    if (keep.has(k)) out[k] = ctx[k];
  }
  return out as Partial<T>;
}

type IncludeSchemaOpts<T extends string> = {
  defaults: readonly T[];
  optional: readonly T[];
  noun?: string;
  describeExtra?: string;
};

// Zod schema for the `include` array param. Description matches the screenshot pattern:
// "Extra <noun> beyond default (<defaults>). Use \"all\" for everything. Options: <optional>."
export function includeFieldSchema<T extends string>(opts: IncludeSchemaOpts<T>) {
  const { defaults, optional, noun = 'fields', describeExtra } = opts;
  const seen = new Set<string>();
  const enumValues = [INCLUDE_ALL, ...defaults, ...optional].filter((v) => {
    if (seen.has(v)) return false;
    seen.add(v);
    return true;
  }) as [string, ...string[]];
  const desc =
    `Extra ${noun} beyond default (${defaults.join(', ') || '—'}). ` +
    `Default fields are always returned; passing them here is a no-op. ` +
    `Use "all" for everything. Options: ${optional.join(', ')}.` +
    (describeExtra ? ` ${describeExtra}` : '');
  return z.array(z.enum(enumValues)).optional().describe(desc);
}

// Sort schema factory — per-tool sortable fields with shared {field, direction} shape.
export function sortFieldSchema<T extends string>(opts: {
  fields: readonly T[];
  desc?: string;
}) {
  const enumValues = [...opts.fields] as unknown as [T, ...T[]];
  return z
    .object({
      field: z.enum(enumValues).describe('Field to sort by'),
      direction: z.enum(['asc', 'desc']).describe('Sort direction'),
    })
    .describe(opts.desc ?? `Sort criteria. Fields: ${opts.fields.join(', ')}.`);
}
