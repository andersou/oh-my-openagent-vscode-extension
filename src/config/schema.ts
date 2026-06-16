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
export type TextVerbosity = 'low' | 'medium' | 'high';

export interface ThinkingConfig {
  type: 'enabled' | 'disabled';
  budgetTokens?: number;
}

export interface FallbackModelConfig {
  model: string;
  variant?: string;
  reasoningEffort?: ReasoningEffort;
  temperature?: number;
  top_p?: number;
  maxTokens?: number;
  thinking?: ThinkingConfig;
}

export type FallbackModels = string | Array<string | FallbackModelConfig>;
export type ToolConfig = Record<string, boolean>;
export type ProviderOptions = Record<string, unknown>;

export interface PermissionConfig {
  edit?: Permission;
  bash?: Permission | Record<string, Permission>;
  webfetch?: Permission;
  doom_loop?: Permission;
  external_directory?: Permission;
}

export interface AgentConfig {
  model?: string;
  variant?: string;
  fallback_models?: FallbackModels;
  temperature?: number;
  top_p?: number;
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort;
  thinking?: ThinkingConfig;
  prompt?: string;
  prompt_append?: string;
  tools?: ToolConfig;
  disable?: boolean;
  permission?: PermissionConfig;
  category?: string;
  mode?: AgentMode;
  color?: string;
  textVerbosity?: TextVerbosity;
  providerOptions?: ProviderOptions;
}

export interface CategoryConfig {
  model?: string;
  variant?: string;
  fallback_models?: FallbackModels;
  temperature?: number;
  top_p?: number;
  maxTokens?: number;
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

export interface Profile {
  name: string;
  description?: string;
  agents?: Record<string, AgentConfig>;
  categories?: Record<string, CategoryConfig>;
  createdAt?: string;
  updatedAt?: string;
}

export interface ProfilesFile {
  profiles: Profile[];
  lastActiveProfile?: string;
  version?: number;
}
