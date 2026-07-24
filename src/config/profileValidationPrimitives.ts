export type ValidationPath = readonly (string | number)[];
export type ProfileValidationErrorCode =
  | 'invalid_type'
  | 'invalid_value'
  | 'missing_field'
  | 'unknown_field'
  | 'unsupported_version';

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

export function fail(
  code: ProfileValidationErrorCode,
  path: ValidationPath,
  requirement: string,
): never {
  throw new ProfileValidationFault(code, path, requirement);
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function plainObject(
  value: unknown,
  path: ValidationPath,
): Record<string, unknown> {
  if (!isPlainObject(value)) {
    fail('invalid_type', path, 'must be a plain object');
  }
  return value;
}

export function knownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: ValidationPath,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail('unknown_field', [...path, key], 'unknown field');
    }
  }
}

export function stringValue(
  value: unknown,
  path: ValidationPath,
): asserts value is string {
  if (typeof value !== 'string') {
    fail('invalid_type', path, 'must be a string');
  }
}

export function nonblankString(
  value: unknown,
  path: ValidationPath,
): asserts value is string {
  stringValue(value, path);
  if (value.trim() === '') {
    fail('invalid_value', path, 'must be a nonblank string');
  }
}

export function positiveInteger(value: unknown, path: ValidationPath): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    fail('invalid_value', path, 'must be a positive integer');
  }
}

export function oneOf<T extends string>(
  value: unknown,
  choices: readonly T[],
  path: ValidationPath,
): asserts value is T {
  if (typeof value !== 'string' || !choices.some((choice) => choice === value)) {
    fail('invalid_value', path, `must be one of: ${choices.join(', ')}`);
  }
}
