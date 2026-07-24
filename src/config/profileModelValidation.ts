import {
  fail,
  isPlainObject,
  knownKeys,
  nonblankString,
  oneOf,
  plainObject,
  positiveInteger,
  stringValue,
  type ValidationPath,
} from './profileValidationPrimitives.js';
import type { ReasoningEffort } from './schema.js';

interface ModelValidationPolicy {
  readonly requireModel: boolean;
  readonly editorCompatibility: boolean;
}

const MODEL_KEYS: readonly string[] = [
  'model', 'variant', 'reasoningEffort', 'temperature', 'top_p', 'maxTokens',
  'thinking',
];
const MAIN_OVERRIDE_KEYS = MODEL_KEYS.filter((key) => key !== 'model');
const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
];
const TRANSFER_OPTIONAL: ModelValidationPolicy = {
  requireModel: false,
  editorCompatibility: false,
};
const TRANSFER_REQUIRED: ModelValidationPolicy = {
  requireModel: true,
  editorCompatibility: false,
};
const EDITOR_OPTIONAL: ModelValidationPolicy = {
  requireModel: false,
  editorCompatibility: true,
};
const EDITOR_REQUIRED: ModelValidationPolicy = {
  requireModel: true,
  editorCompatibility: true,
};

function finiteRange(
  value: unknown,
  path: ValidationPath,
  range: readonly [number, number],
): void {
  const [minimum, maximum] = range;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    fail(
      'invalid_value',
      path,
      `must be a finite number between ${minimum} and ${maximum}`,
    );
  }
}

function finiteNumber(value: unknown, path: ValidationPath): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('invalid_value', path, 'must be a finite number');
  }
}

function thinking(
  value: unknown,
  path: ValidationPath,
  editorCompatibility: boolean,
): void {
  const object = plainObject(value, path);
  if (!editorCompatibility) knownKeys(object, ['type', 'budgetTokens'], path);
  if (editorCompatibility && object.type !== 'enabled' && object.type !== 'disabled') {
    fail('invalid_value', [...path, 'type'], 'must be enabled or disabled');
  }
  if (!editorCompatibility) {
    oneOf(object.type, ['enabled', 'disabled'], [...path, 'type']);
  }
  if (editorCompatibility && (object.type === 'enabled' || Object.hasOwn(object, 'budgetTokens'))) {
    positiveInteger(object.budgetTokens, [...path, 'budgetTokens']);
  }
  if (!editorCompatibility && Object.hasOwn(object, 'budgetTokens')) {
    finiteNumber(object.budgetTokens, [...path, 'budgetTokens']);
  }
}

function modelSettings(
  object: Record<string, unknown>,
  path: ValidationPath,
  policy: ModelValidationPolicy,
): void {
  if (Object.hasOwn(object, 'model')) {
    nonblankString(object.model, [...path, 'model']);
  } else if (policy.requireModel) {
    fail('missing_field', [...path, 'model'], 'must be a nonblank string');
  }
  if (Object.hasOwn(object, 'variant')) {
    stringValue(object.variant, [...path, 'variant']);
  }
  if (Object.hasOwn(object, 'reasoningEffort')) {
    if (policy.editorCompatibility) {
      stringValue(object.reasoningEffort, [...path, 'reasoningEffort']);
    } else {
      oneOf(
        object.reasoningEffort,
        REASONING_EFFORTS,
        [...path, 'reasoningEffort'],
      );
    }
  }
  if (Object.hasOwn(object, 'temperature')) {
    finiteRange(object.temperature, [...path, 'temperature'], [0, 2]);
  }
  if (Object.hasOwn(object, 'top_p')) {
    finiteRange(object.top_p, [...path, 'top_p'], [0, 1]);
  }
  if (Object.hasOwn(object, 'maxTokens')) {
    const tokenPath = [...path, 'maxTokens'];
    if (policy.editorCompatibility) positiveInteger(object.maxTokens, tokenPath);
    else finiteNumber(object.maxTokens, tokenPath);
  }
  if (Object.hasOwn(object, 'thinking')) {
    thinking(
      object.thinking,
      [...path, 'thinking'],
      policy.editorCompatibility,
    );
  }
}

function fallbackModels(
  value: unknown,
  path: ValidationPath,
  editorCompatibility: boolean,
): void {
  if (typeof value === 'string') return nonblankString(value, path);
  if (!Array.isArray(value)) {
    fail('invalid_type', path, 'must be a string or an array');
  }
  value.forEach((fallback, index) => {
    const itemPath = [...path, index];
    if (typeof fallback === 'string') return nonblankString(fallback, itemPath);
    if (editorCompatibility && !isPlainObject(fallback)) {
      fail('invalid_type', itemPath, 'must be a string or a plain object');
    }
    const object = plainObject(fallback, itemPath);
    if (!editorCompatibility) knownKeys(object, MODEL_KEYS, itemPath);
    modelSettings(
      object,
      itemPath,
      editorCompatibility ? EDITOR_REQUIRED : TRANSFER_REQUIRED,
    );
  });
}

function mainOverrides(
  value: unknown,
  path: ValidationPath,
  editorCompatibility: boolean,
): void {
  if (editorCompatibility && !isPlainObject(value)) {
    fail('invalid_type', path, 'must be a plain object or null');
  }
  const object = plainObject(value, path);
  if (Object.hasOwn(object, 'model')) {
    fail('unknown_field', [...path, 'model'], 'must not be set in main overrides');
  }
  if (editorCompatibility) {
    const unknown = Object.keys(object).find(
      (key) => !MAIN_OVERRIDE_KEYS.includes(key),
    );
    if (unknown !== undefined) {
      fail('unknown_field', path, `unknown field: ${unknown}`);
    }
  } else {
    knownKeys(object, MAIN_OVERRIDE_KEYS, path);
  }
  modelSettings(
    object,
    path,
    editorCompatibility ? EDITOR_OPTIONAL : TRANSFER_OPTIONAL,
  );
}

export function validateTransferBaseSettings(
  object: Record<string, unknown>,
  path: ValidationPath,
): void {
  modelSettings(object, path, TRANSFER_OPTIONAL);
  if (Object.hasOwn(object, 'fallback_models')) {
    fallbackModels(object.fallback_models, [...path, 'fallback_models'], false);
  }
  if (Object.hasOwn(object, 'main_overrides')) {
    mainOverrides(object.main_overrides, [...path, 'main_overrides'], false);
  }
}

export function assertEditorPayload<T extends object>(
  value: unknown,
  allowedFields: ReadonlySet<string>,
): asserts value is T {
  const object = plainObject(value, []);
  modelSettings(object, [], EDITOR_OPTIONAL);
  if (Object.hasOwn(object, 'fallback_models')) {
    fallbackModels(object.fallback_models, ['fallback_models'], true);
  }
  if (Object.hasOwn(object, 'main_overrides')) {
    mainOverrides(object.main_overrides, ['main_overrides'], true);
  }
  for (const key of Object.keys(object)) {
    if (!allowedFields.has(key)) {
      fail('unknown_field', [], `Unknown field: ${key}`);
    }
  }
}
