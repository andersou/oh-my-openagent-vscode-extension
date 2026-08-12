export const BUILTIN_AGENTS = [
  'sisyphus',
  'hephaestus',
  'prometheus',
  'oracle',
  'librarian',
  'explore',
  'multimodal-looker',
  'metis',
  'momus',
  'atlas',
  'sisyphus-junior',
] as const;

export const BUILTIN_CATEGORIES = [
  'visual-engineering',
  'ultrabrain',
  'deep',
  'artistry',
  'quick',
  'unspecified-low',
  'unspecified-high',
  'writing',
] as const;

export type BuiltinAgent = (typeof BUILTIN_AGENTS)[number];
export type BuiltinCategory = (typeof BUILTIN_CATEGORIES)[number];

export const BUILTIN_AGENT_DESCRIPTIONS: Record<BuiltinAgent, string> = {
  sisyphus: 'Main orchestrator. Plans, delegates, drives to completion.',
  hephaestus: '"Codex on steroids." Deep autonomous worker, GPT-native.',
  prometheus: 'Strategic planner, interviews you before code is written.',
  oracle: 'Architecture/debugging consultant.',
  librarian: 'External docs/code search.',
  explore: 'Fast codebase grep.',
  'multimodal-looker': 'Vision/PDF analysis.',
  metis: 'Pre-planning consultant, reviews Prometheus plans for gaps.',
  momus: 'High-accuracy plan reviewer.',
  atlas: 'Todo-list orchestrator.',
  'sisyphus-junior': 'Category-spawned executor for delegated tasks.',
};

export const BUILTIN_CATEGORY_DESCRIPTIONS: Record<BuiltinCategory, string> = {
  'visual-engineering': 'Frontend, UI, CSS, design.',
  ultrabrain: 'Maximum reasoning needed.',
  deep: 'Deep coding, complex logic.',
  artistry: 'Creative, novel approaches.',
  quick: 'Simple, fast tasks.',
  'unspecified-low': 'General standard work.',
  'unspecified-high': 'General complex work.',
  writing: 'Text, docs, prose.',
};

export type Permission = 'ask' | 'allow' | 'deny';
export type AgentMode = 'subagent' | 'primary' | 'all';
export type ReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';
export type Reasoning =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'auto';
export type TextVerbosity = 'low' | 'medium' | 'high';

export interface ThinkingConfig {
  type: 'enabled' | 'disabled';
  budgetTokens?: number;
}

export interface ModelVariantConfig {
  model?: string;
  variant?: string;
  reasoning?: Reasoning;
}

export interface FallbackModelConfig {
  model: string;
  variant?: string;
  reasoning?: Reasoning;
  reasoningEffort?: ReasoningEffort;
  temperature?: number;
  top_p?: number;
  maxTokens?: number;
  thinking?: ThinkingConfig;
}

export type MainOverrides = Omit<FallbackModelConfig, 'model'>;

export type FallbackModels = string | Array<string | FallbackModelConfig>;
export type ToolConfig = Record<string, boolean>;
export type ProviderOptions = Record<string, unknown>;

export interface PermissionConfig {
  [tool: string]: Permission | Record<string, Permission> | undefined;
  edit?: Permission;
  bash?: Permission | Record<string, Permission>;
  webfetch?: Permission;
  task?: Permission;
  doom_loop?: Permission;
  external_directory?: Permission;
}

export interface AgentConfig {
  model?: string;
  variant?: string;
  fallback_models?: FallbackModels;
  main_overrides?: MainOverrides;
  temperature?: number;
  top_p?: number;
  maxTokens?: number;
  reasoning?: Reasoning;
  reasoningEffort?: ReasoningEffort;
  thinking?: ThinkingConfig;
  prompt?: string;
  prompt_append?: string;
  skills?: string[];
  tools?: ToolConfig;
  disable?: boolean;
  description?: string;
  permission?: PermissionConfig;
  category?: string;
  mode?: AgentMode;
  color?: string;
  displayName?: string;
  textVerbosity?: TextVerbosity;
  providerOptions?: ProviderOptions;
  ultrawork?: ModelVariantConfig;
  compaction?: ModelVariantConfig;
}

export interface CategoryConfig {
  model?: string;
  variant?: string;
  fallback_models?: FallbackModels;
  main_overrides?: MainOverrides;
  temperature?: number;
  top_p?: number;
  maxTokens?: number;
  reasoning?: Reasoning;
  reasoningEffort?: ReasoningEffort;
  thinking?: ThinkingConfig;
  textVerbosity?: TextVerbosity;
  tools?: ToolConfig;
  prompt_append?: string;
  description?: string;
  is_unstable_agent?: boolean;
  disable?: boolean;
  max_prompt_tokens?: number;
}

export interface OmOConfig {
  agents?: Record<string, AgentConfig>;
  categories?: Record<string, CategoryConfig>;
  agent_order?: string[];
  disabled_agents?: string[];
}

export type ConfigScope = 'global' | 'opencode' | 'senpi' | 'codex';

export const CONFIG_SCOPES = ['global', 'opencode', 'senpi', 'codex'] as const;

export function writePrefixForScope(scope: ConfigScope): readonly string[] {
  return scope === 'global' ? [] : [`[${scope}]`];
}

export function omoConfigKeysForScope(
  scope: ConfigScope,
): ReadonlyArray<keyof OmOConfig> {
  return scope === 'opencode'
    ? ['agents', 'categories', 'agent_order', 'disabled_agents']
    : ['agents', 'categories'];
}

export interface Profile {
  name: string;
  description?: string;
  agents?: Record<string, AgentConfig>;
  categories?: Record<string, CategoryConfig>;
  createdAt?: string;
  updatedAt?: string;
}

export interface ImportProfilesResult {
  mode: 'extend' | 'replace';
  added: number;
  importedNames: string[];
}

export interface ProfilesFile {
  profiles: Profile[];
  lastActiveProfile?: string;
  version?: number;
  configScope?: ConfigScope;
}
