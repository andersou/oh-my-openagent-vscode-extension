import {
  ProfileValidationFault,
  agentConfig,
  assertEditorPayload,
  categoryConfig,
  configMap,
  fail,
  isPlainObject,
  knownKeys,
  nonblankString,
  plainObject,
  stringValue,
  type ProfileValidationErrorCode,
  type ValidationPath,
} from './profileEntryValidation.js';
import type { ProfileTransferRoot } from './profileTransfer.js';
import type { AgentConfig, CategoryConfig, Profile } from './schema.js';

export type { ProfileValidationErrorCode } from './profileEntryValidation.js';

export interface ProfileValidationError {
  readonly code: ProfileValidationErrorCode;
  readonly message: string;
  readonly path: ValidationPath;
}

export type ProfileValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ProfileValidationError };

export interface ProfileFragment {
  readonly agents?: Record<string, AgentConfig>;
  readonly categories?: Record<string, CategoryConfig>;
}

export interface NormalizedProfilesFile {
  readonly version: 1;
  readonly profiles: Profile[];
  readonly lastActiveProfile?: string;
}

export type NormalizedProfileTransferRoot =
  | { readonly kind: 'fragment'; readonly value: ProfileFragment }
  | { readonly kind: 'sidecar'; readonly value: NormalizedProfilesFile };

const PROFILE_KEYS: readonly string[] = [
  'name',
  'description',
  'agents',
  'categories',
  'createdAt',
  'updatedAt',
];
const SIDECAR_KEYS: readonly string[] = [
  'version',
  'profiles',
  'lastActiveProfile',
];
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function fragment(value: unknown): ProfileFragment {
  const object = plainObject(value, []);
  const hasAgents = Object.hasOwn(object, 'agents');
  const hasCategories = Object.hasOwn(object, 'categories');
  if (!hasAgents && !hasCategories) {
    fail('missing_field', [], 'must contain agents or categories');
  }
  return {
    ...(hasAgents
      ? { agents: configMap(object.agents, ['agents'], agentConfig) }
      : {}),
    ...(hasCategories
      ? {
          categories: configMap(
            object.categories,
            ['categories'],
            categoryConfig,
          ),
        }
      : {}),
  };
}

function isoTimestamp(value: unknown, path: ValidationPath): string {
  stringValue(value, path);
  const match = ISO_TIMESTAMP.exec(value);
  if (match === null || !Number.isFinite(Date.parse(value))) {
    fail('invalid_value', path, 'must be an ISO timestamp');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysPerMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > (daysPerMonth[month - 1] ?? 0) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    fail('invalid_value', path, 'must be an ISO timestamp');
  }
  return value;
}

function profile(value: unknown, path: ValidationPath): Profile {
  const object = plainObject(value, path);
  knownKeys(object, PROFILE_KEYS, path);
  if (!Object.hasOwn(object, 'name')) {
    fail('missing_field', [...path, 'name'], 'is required');
  }
  nonblankString(object.name, [...path, 'name']);
  const result: Profile = { name: object.name.trim() };

  if (Object.hasOwn(object, 'description')) {
    stringValue(object.description, [...path, 'description']);
    result.description = object.description;
  }
  if (Object.hasOwn(object, 'agents')) {
    result.agents = configMap(object.agents, [...path, 'agents'], agentConfig);
  }
  if (Object.hasOwn(object, 'categories')) {
    result.categories = configMap(
      object.categories,
      [...path, 'categories'],
      categoryConfig,
    );
  }
  if (Object.hasOwn(object, 'createdAt')) {
    result.createdAt = isoTimestamp(object.createdAt, [...path, 'createdAt']);
  }
  if (Object.hasOwn(object, 'updatedAt')) {
    result.updatedAt = isoTimestamp(object.updatedAt, [...path, 'updatedAt']);
  }
  if (
    result.createdAt !== undefined &&
    result.updatedAt !== undefined &&
    Date.parse(result.updatedAt) < Date.parse(result.createdAt)
  ) {
    fail('invalid_value', [...path, 'updatedAt'], 'must not be before createdAt');
  }
  return result;
}

function profilesFile(value: unknown): NormalizedProfilesFile {
  const object = plainObject(value, []);
  knownKeys(object, SIDECAR_KEYS, []);
  if (!Object.hasOwn(object, 'profiles')) {
    fail('missing_field', ['profiles'], 'is required');
  }
  if (!Array.isArray(object.profiles)) {
    fail('invalid_type', ['profiles'], 'must be an array');
  }
  if (Object.hasOwn(object, 'version')) {
    if (typeof object.version !== 'number' || !Number.isInteger(object.version)) {
      fail('invalid_type', ['version'], 'must be integer 1');
    }
    if (object.version > 1) {
      fail('unsupported_version', ['version'], 'only version 1 is supported');
    }
    if (object.version !== 1) {
      fail('invalid_value', ['version'], 'must be integer 1');
    }
  }

  const result: NormalizedProfilesFile = {
    version: 1,
    profiles: object.profiles.map((entry, index) =>
      profile(entry, ['profiles', index]),
    ),
  };
  if (!Object.hasOwn(object, 'lastActiveProfile')) return result;
  nonblankString(object.lastActiveProfile, ['lastActiveProfile']);
  return { ...result, lastActiveProfile: object.lastActiveProfile.trim() };
}

function captured<T>(validation: () => T): ProfileValidationResult<T> {
  try {
    return { ok: true, value: validation() };
  } catch (error: unknown) {
    if (!(error instanceof ProfileValidationFault)) throw error;
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        path: error.path,
      },
    };
  }
}

export function validateProfileFragment(
  value: unknown,
): ProfileValidationResult<ProfileFragment> {
  return captured(() => fragment(value));
}

export function validateProfile(value: unknown): ProfileValidationResult<Profile> {
  return captured(() => profile(value, []));
}

export function validateProfilesFile(
  value: unknown,
): ProfileValidationResult<NormalizedProfilesFile> {
  return captured(() => profilesFile(value));
}

export function validateProfileTransfer(
  root: ProfileTransferRoot,
): ProfileValidationResult<NormalizedProfileTransferRoot> {
  return captured(() => {
    switch (root.kind) {
      case 'fragment':
        return { kind: 'fragment', value: fragment(root.value) };
      case 'sidecar':
        return { kind: 'sidecar', value: profilesFile(root.value) };
      default:
        return assertNever(root);
    }
  });
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected profile transfer root: ${String(value)}`);
}

export function validateAndClean<T extends object>(
  raw: unknown,
  allowedFields: ReadonlySet<string>,
): T {
  if (!isPlainObject(raw)) throw new TypeError('Save payload must be an object');
  for (const key of Object.keys(raw)) {
    if (!allowedFields.has(key)) throw new TypeError(`Unknown field: ${key}`);
  }
  const cleaned = Object.fromEntries(
    Object.entries(raw).filter(([, value]) => value !== null),
  );
  assertEditorPayload<T>(cleaned, allowedFields);
  return cleaned;
}
