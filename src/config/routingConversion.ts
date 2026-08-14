import type { AgentConfig, CategoryConfig, ConfigScope, OmOConfig } from './schema.js';

// ---------------------------------------------------------------------------
// Internal ↔ public routing conversion
//
// The extension keeps an INTERNAL routing representation (`model` +
// `main_overrides` + `fallback_models`, plus the legacy `variant`) because the
// ordered-card editor and saved profiles are built around it. The PUBLIC
// representation written to `omo.jsonc` is dialect- and scope-dependent.
//
// Dialect × scope matrix (verified empirically against oh-my-opencode 4.19.4
// and 5.0.0-pre bundles plus live `doctor` runs):
//
//   * `mainline` (default): emit one ordered `models` array whose first entry
//     is the primary model merged with `main_overrides`, followed by every
//     fallback. This is the behavior the strict core schema accepts inside
//     `[senpi]`/`[codex]` blocks and the only form the 4.x plugin schema
//     accepts at the config root.
//   * `latest` + `opencode`: emit `model` (plain main model string) with the
//     former `main_overrides` fields flattened to the top level. On key
//     collision the override value wins, except `model` always stays the main
//     model. `fallback_models` is emitted as a dense array (a lone string
//     fallback becomes a one-element array; object entries keep their keys).
//     `models` and `main_overrides` are never emitted. This matches the 5.x
//     runtime's `materializeAgentModelChains` shape for the `[opencode]` block,
//     which is opaque to the 4.x core schema.
//   * `latest` + `global`: identical to `latest` + `opencode` except fallback
//     chains are dropped entirely — the 4.x plugin schema rejects `models` at
//     the root, and the strict core schema rejects `fallback_models` and
//     `category` there.
//   * `latest` + `harness`: identical to `mainline` — the strict core schema
//     accepts `models` inside `[senpi]`/`[codex]` blocks and the opencode plugin
//     validator ignores those blocks.
//
// Conversion rules shared by all dialects
//   * The primary merges `model` with `main_overrides`; a primary without
//     overrides stays a plain model string.
//   * `main_overrides` is NEVER emitted — it is not in the upstream schema.
//   * A `variant` holding a reasoning level becomes `reasoning`; a
//     provider/model variant is kept as `variant`, which upstream still accepts.
//     The conversion applies to the primary, to each fallback object, and to
//     top-level routing.
//   * Mixed modern and legacy routing follows upstream migration order:
//     legacy primary, existing modern entries, then legacy fallbacks.
//   * Non-routing fields are copied through untouched.
//
// The READ path (`toInternalRoutingEntry`/`toInternalRoutingConfig`) is
// bilingual and unchanged: it accepts both `models` chains and the internal
// `model`/`main_overrides`/`fallback_models` shape and always produces the
// internal representation.
// ---------------------------------------------------------------------------

/** Routing keys a public `models[]` entry may carry (upstream schema). */
export const PUBLIC_MODEL_ENTRY_KEYS: readonly string[] = [
  'model',
  'reasoning',
  'variant',
  'reasoningEffort',
  'temperature',
  'top_p',
  'max_tokens',
  'provider_options',
  'maxTokens',
  'providerOptions',
  'textVerbosity',
  'thinking',
];

/** `variant` values that mean a reasoning level rather than a model variant. */
const REASONING_VARIANTS = new Set<string>([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'auto',
]);

export type PublicAgentConfig = Omit<AgentConfig, 'main_overrides'>;

export type PublicCategoryConfig = Omit<CategoryConfig, 'main_overrides'>;

export type RoutingDialect = 'latest' | 'mainline';
export type RoutingScopeKind = 'global' | 'opencode' | 'harness';

export const ROUTING_DIALECTS = ['latest', 'mainline'] as const;

export function routingScopeKindForScope(scope: ConfigScope): RoutingScopeKind {
  if (scope === 'global') return 'global';
  if (scope === 'opencode') return 'opencode';
  return 'harness';
}

export interface PublicOmOConfig {
  agents?: Record<string, PublicAgentConfig>;
  categories?: Record<string, PublicCategoryConfig>;
  agent_order?: string[];
  disabled_agents?: string[];
}

/** An agents/categories fragment in either dialect. */
export interface RoutingFragment {
  agents?: Record<string, AgentConfig>;
  categories?: Record<string, CategoryConfig>;
}

type Entry = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep copy an entry into a mutable record. */
function mutableClone(entry: Entry): Record<string, unknown> {
  return { ...structuredClone(entry) };
}

/** Rewrite a reasoning-level `variant` into `reasoning`, in place. */
function normalizeVariant(entry: Record<string, unknown>): void {
  const variant = entry.variant;
  if (typeof variant !== 'string' || !REASONING_VARIANTS.has(variant)) {
    return;
  }
  delete entry.variant;
  if (entry.reasoning === undefined) {
    entry.reasoning = variant;
  }
}

/** Normalize `fallback_models` (string or array) into a dense entry list. */
function fallbackEntries(value: unknown): Array<string | Record<string, unknown>> {
  if (typeof value === 'string') {
    return [value];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: Array<string | Record<string, unknown>> = [];
  for (const item of value) {
    if (typeof item === 'string') {
      entries.push(item);
    } else if (isRecord(item)) {
      entries.push(structuredClone(item));
    }
  }
  return entries;
}

/** Rewrite every reasoning-level `variant` in an entity, in place. */
function normalizeReasoningVariants(entry: Record<string, unknown>): void {
  normalizeVariant(entry);
  if (isRecord(entry.main_overrides)) {
    normalizeVariant(entry.main_overrides);
  }
  for (const key of ['models', 'fallback_models'] as const) {
    const chain = entry[key];
    if (!Array.isArray(chain)) {
      continue;
    }
    for (const item of chain) {
      if (isRecord(item)) {
        normalizeVariant(item);
      }
    }
  }
}

function isReasoningVariant(variant: unknown): boolean {
  return typeof variant === 'string' && REASONING_VARIANTS.has(variant);
}

/**
 * Fold `main_overrides` into the top-level tuning fields so two entries can be
 * compared by effective routing rather than by provenance. The `latest` disk
 * dialect flattens main overrides into the top level, so a profile snapshot
 * carrying `main_overrides` and a live entry read back from disk differ in
 * shape while meaning the same thing. Override values win on collision, except
 * `model`, which always stays the main model. Reasoning-level `variant` values
 * are normalized to `reasoning` on both the entry and its fallback chains.
 */
export function normalizeRoutingForComparison(
  entry: Entry,
): Record<string, unknown> {
  const result = mutableClone(entry);
  normalizeReasoningVariants(result);
  if (isRecord(result.main_overrides)) {
    const overrides = result.main_overrides;
    delete overrides.model;
    for (const [key, value] of Object.entries(overrides)) {
      result[key] = value;
    }
    delete result.main_overrides;
  }
  return result;
}

function hasMainlineLegacyRouting(entry: Entry): boolean {
  if (entry.main_overrides !== undefined || entry.fallback_models !== undefined) {
    return true;
  }
  if (entry.model !== undefined && entry.models !== undefined) {
    return true;
  }
  return isReasoningVariant(entry.variant);
}

/** True when the entry still carries routing that the public schema rejects. */
export function hasLegacyRouting(
  entry: Entry,
  dialect: RoutingDialect = 'mainline',
  scopeKind: RoutingScopeKind = 'opencode',
): boolean {
  if (dialect === 'mainline' || scopeKind === 'harness') {
    return hasMainlineLegacyRouting(entry);
  }
  if (scopeKind === 'global') {
    return (
      entry.models !== undefined ||
      entry.main_overrides !== undefined ||
      entry.fallback_models !== undefined ||
      isReasoningVariant(entry.variant)
    );
  }
  return (
    entry.models !== undefined ||
    entry.main_overrides !== undefined ||
    isReasoningVariant(entry.variant)
  );
}

/** Convert one entity from the public dialect to the internal one. */
export function toInternalRoutingEntry(entry: Entry): Record<string, unknown> {
  const result = mutableClone(entry);
  normalizeReasoningVariants(result);
  const modernModels = fallbackEntries(result.models);
  const legacyFallbacks = fallbackEntries(result.fallback_models);
  const legacyPrimary =
    typeof result.model === 'string'
      ? isRecord(result.main_overrides) && Object.keys(result.main_overrides).length > 0
        ? { model: result.model, ...structuredClone(result.main_overrides) }
        : result.model
      : undefined;
  const combined = [
    ...(legacyPrimary === undefined ? [] : [legacyPrimary]),
    ...modernModels,
    ...legacyFallbacks,
  ];
  if (combined.length === 0) {
    return result; // legacy-only entity: already the internal representation
  }
  delete result.models;
  const [primary, ...fallbacks] = combined;
  if (primary === undefined) {
    return result;
  }

  delete result.main_overrides;
  delete result.fallback_models;
  if (typeof primary === 'string') {
    result.model = primary;
  } else {
    const { model, ...overrides } = primary;
    if (typeof model === 'string') {
      result.model = model;
    } else {
      delete result.model;
    }
    if (Object.keys(overrides).length > 0) {
      result.main_overrides = overrides;
    }
  }
  if (fallbacks.length > 0) {
    result.fallback_models = fallbacks;
  }
  return result;
}

/** Convert one entity from the internal dialect to the mainline public one. */
function toMainlinePublicRoutingEntry(entry: Entry): Record<string, unknown> {
  const result = toInternalRoutingEntry(entry);
  const overrides = isRecord(result.main_overrides) ? result.main_overrides : {};
  const fallbacks = fallbackEntries(result.fallback_models);

  const primary = result.model;
  if (typeof primary !== 'string') {
    return result;
  }

  const overridden = Object.keys(overrides).length > 0;
  if (!overridden && fallbacks.length === 0) {
    return result; // a plain `model` needs no chain
  }
  delete result.main_overrides;
  delete result.fallback_models;
  delete result.model;
  result.models = [
    overridden ? { model: primary, ...overrides } : primary,
    ...fallbacks,
  ];
  return result;
}

/** Convert one entity from the internal dialect to the latest public one. */
function toLatestPublicRoutingEntry(
  entry: Entry,
  scopeKind: Extract<RoutingScopeKind, 'opencode' | 'global'>,
): Record<string, unknown> {
  const preprocessed = mutableClone(entry);
  normalizeReasoningVariants(preprocessed);

  // Preserve the original primary model even if `main_overrides` also names one.
  if (isRecord(preprocessed.main_overrides)) {
    const overrides = preprocessed.main_overrides;
    delete overrides.model;
    if (Object.keys(overrides).length > 0) {
      preprocessed.main_overrides = overrides;
    } else {
      delete preprocessed.main_overrides;
    }
  }

  const internal = toInternalRoutingEntry(preprocessed);
  const primary = internal.model;
  if (typeof primary !== 'string') {
    return internal;
  }

  const result: Record<string, unknown> = { ...internal };
  delete result.models;
  delete result.main_overrides;
  delete result.fallback_models;

  const overrides = isRecord(internal.main_overrides) ? internal.main_overrides : {};
  for (const [key, value] of Object.entries(overrides)) {
    result[key] = value;
  }

  if (scopeKind === 'opencode') {
    const fallbacks = fallbackEntries(internal.fallback_models);
    if (fallbacks.length > 0) {
      result.fallback_models = fallbacks;
    }
  }

  return result;
}

/** Convert one entity from the internal dialect to the public one. */
export function toPublicRoutingEntry(
  entry: Entry,
  dialect: RoutingDialect = 'mainline',
  scopeKind: RoutingScopeKind = 'opencode',
): Record<string, unknown> {
  if (dialect === 'mainline' || scopeKind === 'harness') {
    return toMainlinePublicRoutingEntry(entry);
  }
  return toLatestPublicRoutingEntry(entry, scopeKind);
}

function convertRoutingConfig(
  config: OmOConfig | PublicOmOConfig | RoutingFragment,
  convert: (entry: Entry) => Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...config };
  for (const group of ['agents', 'categories'] as const) {
    const entries = result[group];
    if (!isRecord(entries)) {
      continue;
    }
    const converted: Record<string, unknown> = {};
    for (const [name, entry] of Object.entries(entries)) {
      converted[name] = isRecord(entry) ? convert(entry) : entry;
    }
    result[group] = converted;
  }
  return result;
}

// Config entities are JSON records by construction, but TypeScript cannot prove
// that a `Record<string, unknown>` satisfies the declared config interfaces.
// The three assertions below are the only seam between the record-level
// helpers above and the exported, typed API.

/** Convert a whole config to the shape written to `omo.jsonc`. */
export function toPublicRoutingConfig(
  config: OmOConfig,
  dialect: RoutingDialect = 'mainline',
  scopeKind: RoutingScopeKind = 'opencode',
): PublicOmOConfig {
  return convertRoutingConfig(
    config,
    (entry) => toPublicRoutingEntry(entry, dialect, scopeKind),
  ) as PublicOmOConfig;
}

/** Convert a whole config read from `omo.jsonc` to the internal shape. */
export function toInternalRoutingConfig(
  config: OmOConfig | PublicOmOConfig,
): OmOConfig {
  return convertRoutingConfig(config, toInternalRoutingEntry) as OmOConfig;
}

/** Convert an `{ agents?, categories? }` fragment to the internal shape. */
export function toInternalRoutingFragment(
  fragment: RoutingFragment,
): RoutingFragment {
  return convertRoutingConfig(fragment, toInternalRoutingEntry) as RoutingFragment;
}
