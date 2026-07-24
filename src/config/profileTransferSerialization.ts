import type {
  NormalizedProfilesFile,
  ProfileFragment,
} from './profileValidation.js';
import type { Profile } from './schema.js';

const PROFILE_SOURCE_EXTENSION = /(?:\.profile\.jsonc|\.profile\.json|\.jsonc|\.json)$/iu;
const UNSAFE_FILENAME_CHARACTERS = /[<>:"/\\|?*\p{Cc}]+/gu;
const TRAILING_FILENAME_CHARACTERS = /[. ]+$/gu;
const WINDOWS_DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/iu;

type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

export type ProfileTransferSerializationErrorCode = 'unsupported_json_value';

export class ProfileTransferSerializationError extends Error {
  public override readonly name = 'ProfileTransferSerializationError';

  public constructor(
    public readonly code: ProfileTransferSerializationErrorCode,
    public readonly path: readonly (string | number)[],
  ) {
    super(`Unsupported JSON value at ${formatPath(path)}`);
  }
}

function formatPath(path: readonly (string | number)[]): string {
  if (path.length === 0) return 'profile transfer root';
  return path.reduce<string>(
    (formatted, part) => typeof part === 'number'
      ? `${formatted}[${part}]`
      : formatted === '' ? part : `${formatted}.${part}`,
    '',
  );
}

function rejectJsonValue(path: readonly (string | number)[]): never {
  throw new ProfileTransferSerializationError('unsupported_json_value', path);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function dataPropertyValue(
  object: object,
  key: PropertyKey,
  path: readonly (string | number)[],
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
    return rejectJsonValue(path);
  }
  return descriptor.value;
}

function isArrayIndex(key: string): boolean {
  return /^(?:0|[1-9]\d*)$/u.test(key) && Number(key) < 4_294_967_295;
}

function canonicalArray(
  value: readonly unknown[],
  path: readonly (string | number)[],
  ancestors: ReadonlySet<object>,
): readonly CanonicalJsonValue[] {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') return rejectJsonValue(path);
    if (key === 'length') continue;
    if (!isArrayIndex(key)) return rejectJsonValue([...path, key]);
    dataPropertyValue(value, key, [...path, Number(key)]);
  }

  const result: CanonicalJsonValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = dataPropertyValue(value, String(index), [...path, index]);
    result.push(canonicalJsonValue(item, [...path, index], ancestors));
  }
  return result;
}

function canonicalObject(
  value: Record<string, unknown>,
  path: readonly (string | number)[],
  ancestors: ReadonlySet<object>,
): { readonly [key: string]: CanonicalJsonValue } {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') return rejectJsonValue(path);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      return rejectJsonValue([...path, key]);
    }
  }

  const result: Record<string, CanonicalJsonValue> = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    const item = dataPropertyValue(value, key, [...path, key]);
    result[key] = canonicalJsonValue(item, [...path, key], ancestors);
  }
  return result;
}

function canonicalJsonValue(
  value: unknown,
  path: readonly (string | number)[],
  ancestors: ReadonlySet<object>,
): CanonicalJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : rejectJsonValue(path);
  }
  if (typeof value !== 'object') return rejectJsonValue(path);
  if (ancestors.has(value)) return rejectJsonValue(path);

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (isJsonArray(value)) return canonicalArray(value, path, nextAncestors);
  if (isPlainObject(value)) return canonicalObject(value, path, nextAncestors);
  return rejectJsonValue(path);
}

export function serializeProfileTransfer(
  value: unknown,
): string {
  const serialized = JSON.stringify(canonicalJsonValue(value, [], new Set()), null, 2);
  if (serialized === undefined) return rejectJsonValue([]);
  return `${serialized}\n`;
}

export function cloneProfileFragment(fragment: ProfileFragment): ProfileFragment {
  return structuredClone(fragment);
}

export function cloneProfilesFile(
  profilesFile: NormalizedProfilesFile,
): NormalizedProfilesFile {
  return structuredClone(profilesFile);
}

export function exportProfileFragment(profile: Profile): ProfileFragment {
  return {
    ...(profile.agents === undefined
      ? {}
      : { agents: structuredClone(profile.agents) }),
    ...(profile.categories === undefined
      ? {}
      : { categories: structuredClone(profile.categories) }),
  };
}

/**
 * Uses the final POSIX or Windows path segment, then NFC-normalizes and trims it.
 * Stored profile names retain their exact case-sensitive identity after derivation.
 */
export function deriveProfileNameFromSource(sourceName: string): string {
  const basename = (sourceName.trim().split(/[\\/]/u).at(-1) ?? '')
    .normalize('NFC')
    .trim();
  const profileName = basename
    .replace(PROFILE_SOURCE_EXTENSION, '')
    .trim();
  return profileName === '' ? 'imported-profile' : profileName;
}

export function resolveProfileNameCollisions(
  existingNames: readonly string[],
  sourceNames: readonly string[],
): string[] {
  const reservedNames = new Set(existingNames);

  return sourceNames.map((sourceName) => {
    let resolvedName = sourceName;
    let suffix = 2;
    while (reservedNames.has(resolvedName)) {
      resolvedName = `${sourceName}-${suffix}`;
      suffix += 1;
    }
    reservedNames.add(resolvedName);
    return resolvedName;
  });
}

export function sanitizeExportBasename(profileName: string): string {
  const sanitized = profileName
    .normalize('NFC')
    .replace(UNSAFE_FILENAME_CHARACTERS, '-')
    .replace(TRAILING_FILENAME_CHARACTERS, '');
  if (sanitized.trim() === '') return 'profile';

  const deviceStem = (sanitized.split('.', 1)[0] ?? '').trimEnd();
  return WINDOWS_DEVICE_NAME.test(deviceStem)
    ? `profile-${sanitized}`
    : sanitized;
}

/**
 * NFC-normalizes sanitized basenames and folds them with en-US lowercase only for
 * filesystem allocation. Stored profile collision rules remain exact and separate.
 */
export function exportFilenameCollisionKey(profileName: string): string {
  return sanitizeExportBasename(profileName).toLocaleLowerCase('en-US');
}

export function resolveExportBasenameCollisions(
  existingNames: readonly string[],
  sourceNames: readonly string[],
): string[] {
  const reservedNames = new Set(existingNames.map(exportFilenameCollisionKey));

  return sourceNames.map((sourceName) => {
    const basename = sanitizeExportBasename(sourceName);
    let resolvedName = basename;
    let suffix = 2;
    while (reservedNames.has(exportFilenameCollisionKey(resolvedName))) {
      resolvedName = `${basename}-${suffix}`;
      suffix += 1;
    }
    reservedNames.add(exportFilenameCollisionKey(resolvedName));
    return resolvedName;
  });
}

export function containsProviderOptions(fragment: ProfileFragment): boolean {
  if (fragment.agents === undefined) return false;

  return Object.values(fragment.agents).some((agent) => {
    const descriptor = Object.getOwnPropertyDescriptor(agent, 'providerOptions');
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) return false;
    return isPlainObject(descriptor.value) && Object.keys(descriptor.value).length > 0;
  });
}
