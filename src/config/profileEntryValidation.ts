import {
  validateTransferBaseSettings,
} from './profileModelValidation.js';
import {
  fail,
  knownKeys,
  oneOf,
  plainObject,
  positiveInteger,
  stringValue,
  type ValidationPath,
} from './profileValidationPrimitives.js';
import type {
  AgentConfig,
  AgentMode,
  CategoryConfig,
  Permission,
  TextVerbosity,
} from './schema.js';

const AGENT_KEYS: readonly string[] = [
  'model', 'variant', 'fallback_models', 'main_overrides', 'temperature',
  'top_p', 'maxTokens', 'reasoningEffort', 'thinking', 'prompt',
  'prompt_append', 'skills', 'tools', 'disable', 'description', 'permission',
  'category', 'mode', 'color', 'displayName', 'textVerbosity',
  'providerOptions', 'ultrawork', 'compaction',
];
const CATEGORY_KEYS: readonly string[] = [
  'model', 'variant', 'fallback_models', 'main_overrides', 'temperature',
  'top_p', 'maxTokens', 'reasoningEffort', 'thinking', 'textVerbosity',
  'tools', 'prompt_append', 'description', 'is_unstable_agent', 'disable',
  'max_prompt_tokens',
];
const AGENT_MODES: readonly AgentMode[] = ['subagent', 'primary', 'all'];
const TEXT_VERBOSITIES: readonly TextVerbosity[] = ['low', 'medium', 'high'];
const PERMISSIONS: readonly Permission[] = ['ask', 'allow', 'deny'];
const SIX_DIGIT_HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

function booleanMap(value: unknown, path: ValidationPath): void {
  for (const [key, enabled] of Object.entries(plainObject(value, path))) {
    if (typeof enabled !== 'boolean') {
      fail('invalid_type', [...path, key], 'must be a boolean');
    }
  }
}

function permissionMap(value: unknown, path: ValidationPath): void {
  for (const [tool, permission] of Object.entries(plainObject(value, path))) {
    if (typeof permission === 'string') {
      oneOf(permission, PERMISSIONS, [...path, tool]);
      continue;
    }
    if (tool !== 'bash') {
      fail('invalid_type', [...path, tool], 'must be ask, allow, or deny');
    }
    for (const [pattern, nested] of Object.entries(
      plainObject(permission, [...path, tool]),
    )) {
      oneOf(nested, PERMISSIONS, [...path, tool, pattern]);
    }
  }
}

function modelVariant(value: unknown, path: ValidationPath): void {
  const object = plainObject(value, path);
  knownKeys(object, ['model', 'variant'], path);
  if (Object.hasOwn(object, 'model')) {
    stringValue(object.model, [...path, 'model']);
  }
  if (Object.hasOwn(object, 'variant')) {
    stringValue(object.variant, [...path, 'variant']);
  }
}

export function agentConfig(value: unknown, path: ValidationPath): AgentConfig {
  const object = plainObject(value, path);
  knownKeys(object, AGENT_KEYS, path);
  validateTransferBaseSettings(object, path);
  for (const key of [
    'prompt',
    'prompt_append',
    'description',
    'category',
    'displayName',
  ] as const) {
    if (Object.hasOwn(object, key)) stringValue(object[key], [...path, key]);
  }
  if (Object.hasOwn(object, 'color')) {
    stringValue(object.color, [...path, 'color']);
    if (!SIX_DIGIT_HEX_COLOR.test(object.color)) {
      fail('invalid_value', [...path, 'color'], 'must be a six-digit hex color');
    }
  }
  if (Object.hasOwn(object, 'skills')) {
    if (!Array.isArray(object.skills)) {
      fail('invalid_type', [...path, 'skills'], 'must be an array');
    }
    object.skills.forEach((skill, index) =>
      stringValue(skill, [...path, 'skills', index]),
    );
  }
  if (Object.hasOwn(object, 'tools')) {
    booleanMap(object.tools, [...path, 'tools']);
  }
  if (Object.hasOwn(object, 'disable') && typeof object.disable !== 'boolean') {
    fail('invalid_type', [...path, 'disable'], 'must be a boolean');
  }
  if (Object.hasOwn(object, 'permission')) {
    permissionMap(object.permission, [...path, 'permission']);
  }
  if (Object.hasOwn(object, 'mode')) {
    oneOf(object.mode, AGENT_MODES, [...path, 'mode']);
  }
  if (Object.hasOwn(object, 'textVerbosity')) {
    oneOf(object.textVerbosity, TEXT_VERBOSITIES, [...path, 'textVerbosity']);
  }
  if (Object.hasOwn(object, 'providerOptions')) {
    plainObject(object.providerOptions, [...path, 'providerOptions']);
  }
  if (Object.hasOwn(object, 'ultrawork')) {
    modelVariant(object.ultrawork, [...path, 'ultrawork']);
  }
  if (Object.hasOwn(object, 'compaction')) {
    modelVariant(object.compaction, [...path, 'compaction']);
  }
  return object;
}

export function categoryConfig(
  value: unknown,
  path: ValidationPath,
): CategoryConfig {
  const object = plainObject(value, path);
  knownKeys(object, CATEGORY_KEYS, path);
  validateTransferBaseSettings(object, path);
  for (const key of ['prompt_append', 'description'] as const) {
    if (Object.hasOwn(object, key)) stringValue(object[key], [...path, key]);
  }
  if (Object.hasOwn(object, 'tools')) {
    booleanMap(object.tools, [...path, 'tools']);
  }
  for (const key of ['is_unstable_agent', 'disable'] as const) {
    if (Object.hasOwn(object, key) && typeof object[key] !== 'boolean') {
      fail('invalid_type', [...path, key], 'must be a boolean');
    }
  }
  if (Object.hasOwn(object, 'max_prompt_tokens')) {
    positiveInteger(object.max_prompt_tokens, [...path, 'max_prompt_tokens']);
  }
  if (Object.hasOwn(object, 'textVerbosity')) {
    oneOf(object.textVerbosity, TEXT_VERBOSITIES, [...path, 'textVerbosity']);
  }
  return object;
}

export function configMap<T>(
  value: unknown,
  path: ValidationPath,
  validate: (entry: unknown, path: ValidationPath) => T,
): Record<string, T> {
  const result: Record<string, T> = {};
  for (const [name, entry] of Object.entries(plainObject(value, path))) {
    result[name] = validate(entry, [...path, name]);
  }
  return result;
}
