import type { AgentConfig, CategoryConfig, OmOConfig } from './schema.js';

// ---------------------------------------------------------------------------
// Internal ↔ public routing conversion
//
// The extension keeps an INTERNAL routing representation (`model` +
// `main_overrides` + `fallback_models`, plus the legacy `variant`) because the
// ordered-card editor and saved profiles are built around it. The PUBLIC
// representation written to `omo.jsonc` is what the upstream schema and
// `oh-my-openagent doctor` accept: one ordered `models` array plus `reasoning`.
//
// Conversion rules
//   * `models[0]` is the primary; every later entry is a fallback, in order.
//   * The primary merges `model` with `main_overrides`; a primary without
//     overrides stays a plain model string.
//   * `main_overrides` is NEVER emitted — it is not in the upstream schema.
//   * `fallback_models` is NEVER emitted — doctor 4.19.4 deprecates it.
//   * A `variant` holding a reasoning level becomes `reasoning`; a
//     provider/model variant is kept as `variant`, which upstream still accepts.
//     The conversion applies to the primary, to each fallback object, and to
//     top-level routing.
//   * Mixed modern and legacy routing follows upstream migration order:
//     legacy primary, existing modern entries, then legacy fallbacks.
//   * Non-routing fields are copied through untouched.
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

/** Entity keys the conversion owns; everything else is passed through. */
export const ROUTING_ENTITY_KEYS: readonly string[] = [
  'model',
  'models',
  'variant',
  'reasoning',
  'main_overrides',
  'fallback_models',
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

export type PublicAgentConfig = Omit<
  AgentConfig,
  'main_overrides' | 'fallback_models'
>;

export type PublicCategoryConfig = Omit<
  CategoryConfig,
  'main_overrides' | 'fallback_models'
>;

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

/** True when the entry still carries routing that the public schema rejects. */
export function hasLegacyRouting(entry: Entry): boolean {
  if (entry.main_overrides !== undefined || entry.fallback_models !== undefined) {
    return true;
  }
  if (entry.model !== undefined && entry.models !== undefined) {
    return true;
  }
  return typeof entry.variant === 'string' && REASONING_VARIANTS.has(entry.variant);
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

/** Convert one entity from the internal dialect to the public one. */
export function toPublicRoutingEntry(entry: Entry): Record<string, unknown> {
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
export function toPublicRoutingConfig(config: OmOConfig): PublicOmOConfig {
  return convertRoutingConfig(config, toPublicRoutingEntry) as PublicOmOConfig;
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
