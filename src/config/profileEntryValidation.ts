import type {
  AgentConfig,
  AgentMode,
  CategoryConfig,
  Permission,
  ReasoningEffort,
  TextVerbosity,
} from './schema.js';

export type ValidationPath = readonly (string | number)[];
export type ProfileValidationErrorCode =
  | 'invalid_type'
  | 'invalid_value'
  | 'missing_field'
  | 'unknown_field'
  | 'unsupported_version';

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
const MODEL_KEYS: readonly string[] = [
  'model', 'variant', 'reasoningEffort', 'temperature', 'top_p', 'maxTokens',
  'thinking',
];
const MAIN_OVERRIDE_KEYS = MODEL_KEYS.filter((key) => key !== 'model');
const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
];
const AGENT_MODES: readonly AgentMode[] = ['subagent', 'primary', 'all'];
const TEXT_VERBOSITIES: readonly TextVerbosity[] = ['low', 'medium', 'high'];
const PERMISSIONS: readonly Permission[] = ['ask', 'allow', 'deny'];

export class ProfileValidationFault extends Error {
  public override readonly name = 'ProfileValidationFault';

  public constructor(
    public readonly code: ProfileValidationErrorCode,
    public readonly path: ValidationPath,
    requirement: string,
  ) {
    super(`Invalid ${formatPath(path)}: ${requirement}`);
  }
}

function formatPath(path: ValidationPath): string {
  if (path.length === 0) return 'profile transfer';
  return path.reduce<string>(
    (formatted, part) => typeof part === 'number'
      ? `${formatted}[${part}]`
      : formatted === '' ? part : `${formatted}.${part}`,
    '',
  );
}

export function fail(code: ProfileValidationErrorCode, path: ValidationPath, requirement: string): never {
  throw new ProfileValidationFault(code, path, requirement);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function plainObject(value: unknown, path: ValidationPath): Record<string, unknown> {
  if (!isPlainObject(value)) fail('invalid_type', path, 'must be a plain object');
  return value;
}

export function knownKeys(value: Record<string, unknown>, allowed: readonly string[], path: ValidationPath): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail('unknown_field', [...path, key], 'unknown field');
  }
}

export function stringValue(value: unknown, path: ValidationPath): asserts value is string {
  if (typeof value !== 'string') fail('invalid_type', path, 'must be a string');
}

export function nonblankString(value: unknown, path: ValidationPath): asserts value is string {
  stringValue(value, path);
  if (value.trim() === '') fail('invalid_value', path, 'must be a nonblank string');
}

function finiteRange(value: unknown, path: ValidationPath, minimum: number, maximum: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail('invalid_value', path, `must be a finite number between ${minimum} and ${maximum}`);
  }
}

function positiveInteger(value: unknown, path: ValidationPath): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    fail('invalid_value', path, 'must be a positive integer');
  }
}

function oneOf<T extends string>(value: unknown, choices: readonly T[], path: ValidationPath): asserts value is T {
  if (typeof value !== 'string' || !choices.some((choice) => choice === value)) {
    fail('invalid_value', path, `must be one of: ${choices.join(', ')}`);
  }
}

function thinking(value: unknown, path: ValidationPath, editorCompatibility: boolean): void {
  const object = plainObject(value, path);
  if (!editorCompatibility) knownKeys(object, ['type', 'budgetTokens'], path);
  if (editorCompatibility && object.type !== 'enabled' && object.type !== 'disabled') {
    fail('invalid_value', [...path, 'type'], 'must be enabled or disabled');
  }
  if (!editorCompatibility) oneOf(object.type, ['enabled', 'disabled'], [...path, 'type']);
  if (object.type === 'enabled' || Object.hasOwn(object, 'budgetTokens')) {
    positiveInteger(object.budgetTokens, [...path, 'budgetTokens']);
  }
}

function modelSettings(
  object: Record<string, unknown>,
  path: ValidationPath,
  requireModel: boolean,
  editorCompatibility: boolean,
): void {
  if (Object.hasOwn(object, 'model')) nonblankString(object.model, [...path, 'model']);
  else if (requireModel) fail('missing_field', [...path, 'model'], 'must be a nonblank string');
  if (Object.hasOwn(object, 'variant')) stringValue(object.variant, [...path, 'variant']);
  if (Object.hasOwn(object, 'reasoningEffort')) {
    if (editorCompatibility) stringValue(object.reasoningEffort, [...path, 'reasoningEffort']);
    else oneOf(object.reasoningEffort, REASONING_EFFORTS, [...path, 'reasoningEffort']);
  }
  if (Object.hasOwn(object, 'temperature')) finiteRange(object.temperature, [...path, 'temperature'], 0, 2);
  if (Object.hasOwn(object, 'top_p')) finiteRange(object.top_p, [...path, 'top_p'], 0, 1);
  if (Object.hasOwn(object, 'maxTokens')) positiveInteger(object.maxTokens, [...path, 'maxTokens']);
  if (Object.hasOwn(object, 'thinking')) thinking(object.thinking, [...path, 'thinking'], editorCompatibility);
}

function fallbackModels(value: unknown, path: ValidationPath, editorCompatibility: boolean): void {
  if (typeof value === 'string') return nonblankString(value, path);
  if (!Array.isArray(value)) fail('invalid_type', path, 'must be a string or an array');
  value.forEach((fallback, index) => {
    const itemPath = [...path, index];
    if (typeof fallback === 'string') return nonblankString(fallback, itemPath);
    if (editorCompatibility && !isPlainObject(fallback)) {
      fail('invalid_type', itemPath, 'must be a string or a plain object');
    }
    const object = plainObject(fallback, itemPath);
    if (!editorCompatibility) knownKeys(object, MODEL_KEYS, itemPath);
    modelSettings(object, itemPath, true, editorCompatibility);
  });
}

function mainOverrides(value: unknown, path: ValidationPath, editorCompatibility: boolean): void {
  if (editorCompatibility && !isPlainObject(value)) {
    fail('invalid_type', path, 'must be a plain object or null');
  }
  const object = plainObject(value, path);
  if (Object.hasOwn(object, 'model')) {
    fail('unknown_field', [...path, 'model'], 'must not be set in main overrides');
  }
  if (editorCompatibility) {
    const unknown = Object.keys(object).find((key) => !MAIN_OVERRIDE_KEYS.includes(key));
    if (unknown !== undefined) fail('unknown_field', path, `unknown field: ${unknown}`);
  } else knownKeys(object, MAIN_OVERRIDE_KEYS, path);
  modelSettings(object, path, false, editorCompatibility);
}

function baseSettings(object: Record<string, unknown>, path: ValidationPath): void {
  modelSettings(object, path, false, false);
  if (Object.hasOwn(object, 'fallback_models')) {
    fallbackModels(object.fallback_models, [...path, 'fallback_models'], false);
  }
  if (Object.hasOwn(object, 'main_overrides')) {
    mainOverrides(object.main_overrides, [...path, 'main_overrides'], false);
  }
}

function booleanMap(value: unknown, path: ValidationPath): void {
  for (const [key, enabled] of Object.entries(plainObject(value, path))) {
    if (typeof enabled !== 'boolean') fail('invalid_type', [...path, key], 'must be a boolean');
  }
}

function permissionMap(value: unknown, path: ValidationPath): void {
  for (const [tool, permission] of Object.entries(plainObject(value, path))) {
    if (typeof permission === 'string') oneOf(permission, PERMISSIONS, [...path, tool]);
    else for (const [pattern, nested] of Object.entries(plainObject(permission, [...path, tool]))) {
      oneOf(nested, PERMISSIONS, [...path, tool, pattern]);
    }
  }
}

function modelVariant(value: unknown, path: ValidationPath): void {
  const object = plainObject(value, path);
  knownKeys(object, ['model', 'variant'], path);
  if (Object.hasOwn(object, 'model')) nonblankString(object.model, [...path, 'model']);
  if (Object.hasOwn(object, 'variant')) stringValue(object.variant, [...path, 'variant']);
}

export function agentConfig(value: unknown, path: ValidationPath): AgentConfig {
  const object = plainObject(value, path);
  knownKeys(object, AGENT_KEYS, path);
  baseSettings(object, path);
  for (const key of ['prompt', 'prompt_append', 'description', 'category', 'color', 'displayName'] as const) {
    if (Object.hasOwn(object, key)) stringValue(object[key], [...path, key]);
  }
  if (Object.hasOwn(object, 'skills')) {
    if (!Array.isArray(object.skills)) fail('invalid_type', [...path, 'skills'], 'must be an array');
    object.skills.forEach((skill, index) => stringValue(skill, [...path, 'skills', index]));
  }
  if (Object.hasOwn(object, 'tools')) booleanMap(object.tools, [...path, 'tools']);
  if (Object.hasOwn(object, 'disable') && typeof object.disable !== 'boolean') {
    fail('invalid_type', [...path, 'disable'], 'must be a boolean');
  }
  if (Object.hasOwn(object, 'permission')) permissionMap(object.permission, [...path, 'permission']);
  if (Object.hasOwn(object, 'mode')) oneOf(object.mode, AGENT_MODES, [...path, 'mode']);
  if (Object.hasOwn(object, 'textVerbosity')) {
    oneOf(object.textVerbosity, TEXT_VERBOSITIES, [...path, 'textVerbosity']);
  }
  if (Object.hasOwn(object, 'providerOptions')) {
    plainObject(object.providerOptions, [...path, 'providerOptions']);
  }
  if (Object.hasOwn(object, 'ultrawork')) modelVariant(object.ultrawork, [...path, 'ultrawork']);
  if (Object.hasOwn(object, 'compaction')) modelVariant(object.compaction, [...path, 'compaction']);
  return object;
}

export function categoryConfig(value: unknown, path: ValidationPath): CategoryConfig {
  const object = plainObject(value, path);
  knownKeys(object, CATEGORY_KEYS, path);
  baseSettings(object, path);
  for (const key of ['prompt_append', 'description'] as const) {
    if (Object.hasOwn(object, key)) stringValue(object[key], [...path, key]);
  }
  if (Object.hasOwn(object, 'tools')) booleanMap(object.tools, [...path, 'tools']);
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

export function configMap<T>(value: unknown, path: ValidationPath, validate: (entry: unknown, path: ValidationPath) => T): Record<string, T> {
  const result: Record<string, T> = {};
  for (const [name, entry] of Object.entries(plainObject(value, path))) {
    result[name] = validate(entry, [...path, name]);
  }
  return result;
}

export function assertEditorPayload<T extends object>(value: unknown, allowedFields: ReadonlySet<string>): asserts value is T {
  const object = plainObject(value, []);
  modelSettings(object, [], false, true);
  if (Object.hasOwn(object, 'fallback_models')) {
    fallbackModels(object.fallback_models, ['fallback_models'], true);
  }
  if (Object.hasOwn(object, 'main_overrides')) {
    mainOverrides(object.main_overrides, ['main_overrides'], true);
  }
  for (const key of Object.keys(object)) {
    if (!allowedFields.has(key)) fail('unknown_field', [], `Unknown field: ${key}`);
  }
}
