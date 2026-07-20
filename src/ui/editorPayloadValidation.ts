function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidSetting(field: string, requirement: string): never {
  throw new Error(`Invalid ${field}: ${requirement}`);
}

function validateString(value: unknown, field: string): void {
  if (typeof value !== 'string') {
    invalidSetting(field, 'must be a string');
  }
}

function validateNonblankString(value: unknown, field: string): void {
  if (typeof value !== 'string') {
    invalidSetting(field, 'must be a string');
  }
  if (value.trim() === '') {
    invalidSetting(field, 'must be a nonblank string');
  }
}

function validateTemperature(value: unknown, field: string): void {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 2
  ) {
    invalidSetting(field, 'must be a finite number between 0 and 2');
  }
}

function validateTopP(value: unknown, field: string): void {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    invalidSetting(field, 'must be a finite number between 0 and 1');
  }
}

function validatePositiveInteger(value: unknown, field: string): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    invalidSetting(field, 'must be a positive integer');
  }
}

function validateThinking(value: unknown, field: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    invalidSetting(field, 'must be a plain object');
  }
  if (value.type !== 'enabled' && value.type !== 'disabled') {
    invalidSetting(`${field}.type`, 'must be enabled or disabled');
  }
  if (value.type === 'enabled' || Object.hasOwn(value, 'budgetTokens')) {
    validatePositiveInteger(value.budgetTokens, `${field}.budgetTokens`);
  }
  return { ...value };
}

function fieldPath(prefix: string, field: string): string {
  return prefix === '' ? field : `${prefix}.${field}`;
}

function validateModelSettings(
  settings: Record<string, unknown>,
  prefix: string,
  requireModel: boolean,
): Record<string, unknown> {
  const cleaned = { ...settings };
  const modelField = fieldPath(prefix, 'model');

  if (Object.hasOwn(settings, 'model')) {
    validateNonblankString(settings.model, modelField);
  } else if (requireModel) {
    invalidSetting(modelField, 'must be a nonblank string');
  }

  for (const field of ['variant', 'reasoningEffort'] as const) {
    if (Object.hasOwn(settings, field)) {
      validateString(settings[field], fieldPath(prefix, field));
    }
  }
  if (Object.hasOwn(settings, 'temperature')) {
    validateTemperature(settings.temperature, fieldPath(prefix, 'temperature'));
  }
  if (Object.hasOwn(settings, 'top_p')) {
    validateTopP(settings.top_p, fieldPath(prefix, 'top_p'));
  }
  if (Object.hasOwn(settings, 'maxTokens')) {
    validatePositiveInteger(settings.maxTokens, fieldPath(prefix, 'maxTokens'));
  }
  if (Object.hasOwn(settings, 'thinking')) {
    cleaned.thinking = validateThinking(
      settings.thinking,
      fieldPath(prefix, 'thinking'),
    );
  }

  return cleaned;
}

function validateFallbackModels(value: unknown): unknown {
  if (typeof value === 'string') {
    validateNonblankString(value, 'fallback_models');
    return value;
  }
  if (!Array.isArray(value)) {
    invalidSetting('fallback_models', 'must be a string or an array');
  }

  return value.map((fallback, index) => {
    const fallbackField = `fallback_models[${index}]`;
    if (typeof fallback === 'string') {
      validateNonblankString(fallback, fallbackField);
      return fallback;
    }
    if (!isPlainObject(fallback)) {
      invalidSetting(fallbackField, 'must be a string or a plain object');
    }
    return validateModelSettings(fallback, fallbackField, true);
  });
}

export function validateAndClean<T extends object>(
  raw: unknown,
  allowedFields: ReadonlySet<string>,
): T {
  if (!isPlainObject(raw)) {
    throw new Error('Save payload must be an object');
  }

  for (const key of Object.keys(raw)) {
    if (!allowedFields.has(key)) {
      throw new Error(`Unknown field: ${key}`);
    }
  }

  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== null) {
      cleaned[key] = value;
    }
  }

  const validated = validateModelSettings(cleaned, '', false);
  if (Object.hasOwn(validated, 'fallback_models')) {
    validated.fallback_models = validateFallbackModels(validated.fallback_models);
  }
  return validated as T;
}
