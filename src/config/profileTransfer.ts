import {
  getLocation,
  parse,
  printParseErrorCode,
  visit,
  type ParseError,
  type ParseOptions,
} from 'jsonc-parser';

export * from './profileTransferSerialization.js';
export { validateProfileTransfer } from './profileValidation.js';

export const MAX_PROFILE_TRANSFER_BYTES = 5 * 1024 * 1024;

export interface UnvalidatedJsonObject {
  readonly [key: string]: unknown;
}

export interface UnvalidatedProfileFragmentRoot {
  readonly kind: 'fragment';
  readonly value: UnvalidatedJsonObject;
}

export interface UnvalidatedProfileSidecarRoot {
  readonly kind: 'sidecar';
  readonly value: UnvalidatedJsonObject;
}

export type ProfileTransferRoot =
  | UnvalidatedProfileFragmentRoot
  | UnvalidatedProfileSidecarRoot;

export type ProfileTransferParseErrorCode =
  | 'input_too_large'
  | 'invalid_utf8'
  | 'syntax_error'
  | 'duplicate_key'
  | 'root_not_object'
  | 'mixed_root'
  | 'missing_profile_sections';

export interface ProfileTransferParseError {
  readonly code: ProfileTransferParseErrorCode;
  readonly message: string;
  readonly path: readonly (string | number)[];
  readonly line?: number;
  readonly column?: number;
}

export interface ProfileTransferParseSuccess {
  readonly ok: true;
  readonly root: ProfileTransferRoot;
}

export interface ProfileTransferParseFailure {
  readonly ok: false;
  readonly error: ProfileTransferParseError;
}

export type ProfileTransferParseResult =
  | ProfileTransferParseSuccess
  | ProfileTransferParseFailure;

export interface ProfileFragmentParseSuccess {
  readonly ok: true;
  readonly value: UnvalidatedJsonObject;
}

export type ProfileFragmentParseResult =
  | ProfileFragmentParseSuccess
  | ProfileTransferParseFailure;

interface SourceLocation {
  readonly line: number;
  readonly column: number;
}

interface LocatedProperty extends SourceLocation {
  readonly path: readonly (string | number)[];
}

interface PropertyScan {
  readonly duplicate?: LocatedProperty;
  readonly rootProperties: ReadonlyMap<string, SourceLocation>;
}

const JSONC_OPTIONS: ParseOptions = {
  allowEmptyContent: false,
  allowTrailingComma: true,
  disallowComments: false,
};

function isJsonObject(value: unknown): value is UnvalidatedJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getParseErrorLocation(
  text: string,
  parseError: ParseError,
): SourceLocation {
  let location: SourceLocation | undefined;

  visit(
    text,
    {
      onError: (error, offset, _length, startLine, startCharacter) => {
        if (error === parseError.error && offset === parseError.offset) {
          location = {
            line: startLine + 1,
            column: startCharacter + 1,
          };
        }
      },
    },
    JSONC_OPTIONS,
  );

  if (location === undefined) {
    throw new RangeError('jsonc-parser omitted coordinates for its parse error');
  }
  return location;
}

function scanProperties(text: string): PropertyScan {
  const objectKeys: Array<Set<string>> = [];
  const rootProperties = new Map<string, SourceLocation>();
  let duplicate: LocatedProperty | undefined;

  visit(
    text,
    {
      onObjectBegin: () => {
        objectKeys.push(new Set<string>());
      },
      onObjectProperty: (
        property,
        _offset,
        _length,
        startLine,
        startCharacter,
        pathSupplier,
      ) => {
        const parentPath = pathSupplier();
        const currentKeys = objectKeys[objectKeys.length - 1];
        const location = {
          line: startLine + 1,
          column: startCharacter + 1,
        };

        if (parentPath.length === 0 && !rootProperties.has(property)) {
          rootProperties.set(property, location);
        }
        if (duplicate === undefined && currentKeys.has(property)) {
          duplicate = {
            ...location,
            path: [...parentPath, property],
          };
        }
        currentKeys.add(property);
      },
      onObjectEnd: () => {
        objectKeys.pop();
      },
    },
    JSONC_OPTIONS,
  );

  return duplicate === undefined
    ? { rootProperties }
    : { duplicate, rootProperties };
}

/** Parse transfer bytes without validating or normalizing nested profile data. */
export function parseProfileTransfer(
  input: Uint8Array,
): ProfileTransferParseResult {
  if (input.byteLength > MAX_PROFILE_TRANSFER_BYTES) {
    return {
      ok: false,
      error: {
        code: 'input_too_large',
        message: `Transfer input exceeds ${MAX_PROFILE_TRANSFER_BYTES} bytes`,
        path: [],
      },
    };
  }

  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(input);
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) {
      throw error;
    }
    return {
      ok: false,
      error: {
        code: 'invalid_utf8',
        message: 'Transfer input is not valid UTF-8',
        path: [],
      },
    };
  }

  const text = decoded.startsWith('\uFEFF') ? decoded.slice(1) : decoded;
  const parseErrors: ParseError[] = [];
  const value: unknown = parse(text, parseErrors, JSONC_OPTIONS);
  const firstParseError = parseErrors[0];

  if (firstParseError !== undefined) {
    const location = getParseErrorLocation(text, firstParseError);
    return {
      ok: false,
      error: {
        code: 'syntax_error',
        message: `Invalid JSONC: ${printParseErrorCode(firstParseError.error)}`,
        path: [...getLocation(text, firstParseError.offset).path],
        line: location.line,
        column: location.column,
      },
    };
  }

  const propertyScan = scanProperties(text);
  if (propertyScan.duplicate !== undefined) {
    return {
      ok: false,
      error: {
        code: 'duplicate_key',
        message: 'Transfer input contains a duplicate JSON key',
        path: propertyScan.duplicate.path,
        line: propertyScan.duplicate.line,
        column: propertyScan.duplicate.column,
      },
    };
  }

  if (!isJsonObject(value)) {
    return {
      ok: false,
      error: {
        code: 'root_not_object',
        message: 'Transfer input root must be a JSON object',
        path: [],
        line: 1,
        column: 1,
      },
    };
  }

  const hasProfiles = Object.hasOwn(value, 'profiles');
  const hasAgents = Object.hasOwn(value, 'agents');
  const hasCategories = Object.hasOwn(value, 'categories');

  if (hasProfiles) {
    const conflict = hasAgents ? 'agents' : hasCategories ? 'categories' : undefined;
    if (conflict !== undefined) {
      const location = propertyScan.rootProperties.get(conflict);
      return {
        ok: false,
        error: {
          code: 'mixed_root',
          message: 'A sidecar root cannot contain fragment sections',
          path: [conflict],
          line: location?.line ?? 1,
          column: location?.column ?? 1,
        },
      };
    }
    return { ok: true, root: { kind: 'sidecar', value } };
  }

  if (hasAgents || hasCategories) {
    return { ok: true, root: { kind: 'fragment', value } };
  }

  return {
    ok: false,
    error: {
      code: 'missing_profile_sections',
      message: 'Transfer input must contain agents, categories, or profiles',
      path: [],
      line: 1,
      column: 1,
    },
  };
}

/** Parse an oh-my-openagent config byte fragment and extract only the agent/category sections.
 *
 * Unlike {@link parseProfileTransfer}, this accepts config roots that also contain
 * `profiles` or `version` sidecar keys. Only `agents` and `categories` are returned;
 * all other top-level keys are ignored. At least one of the two sections must be present.
 */
export function parseConfigFragmentBytes(
  input: Uint8Array,
): ProfileFragmentParseResult {
  if (input.byteLength > MAX_PROFILE_TRANSFER_BYTES) {
    return {
      ok: false,
      error: {
        code: 'input_too_large',
        message: `Config input exceeds ${MAX_PROFILE_TRANSFER_BYTES} bytes`,
        path: [],
      },
    };
  }

  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(input);
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) {
      throw error;
    }
    return {
      ok: false,
      error: {
        code: 'invalid_utf8',
        message: 'Config input is not valid UTF-8',
        path: [],
      },
    };
  }

  const text = decoded.startsWith('\uFEFF') ? decoded.slice(1) : decoded;
  const parseErrors: ParseError[] = [];
  const value: unknown = parse(text, parseErrors, JSONC_OPTIONS);
  const firstParseError = parseErrors[0];

  if (firstParseError !== undefined) {
    const location = getParseErrorLocation(text, firstParseError);
    return {
      ok: false,
      error: {
        code: 'syntax_error',
        message: `Invalid JSONC: ${printParseErrorCode(firstParseError.error)}`,
        path: [...getLocation(text, firstParseError.offset).path],
        line: location.line,
        column: location.column,
      },
    };
  }

  const propertyScan = scanProperties(text);
  if (propertyScan.duplicate !== undefined) {
    return {
      ok: false,
      error: {
        code: 'duplicate_key',
        message: 'Config input contains a duplicate JSON key',
        path: propertyScan.duplicate.path,
        line: propertyScan.duplicate.line,
        column: propertyScan.duplicate.column,
      },
    };
  }

  if (!isJsonObject(value)) {
    return {
      ok: false,
      error: {
        code: 'root_not_object',
        message: 'Config input root must be a JSON object',
        path: [],
        line: 1,
        column: 1,
      },
    };
  }

  const hasAgents = Object.hasOwn(value, 'agents');
  const hasCategories = Object.hasOwn(value, 'categories');

  if (!hasAgents && !hasCategories) {
    return {
      ok: false,
      error: {
        code: 'missing_profile_sections',
        message: 'Config input must contain agents or categories',
        path: [],
        line: 1,
        column: 1,
      },
    };
  }

  return {
    ok: true,
    value: {
      ...(hasAgents ? { agents: value.agents } : {}),
      ...(hasCategories ? { categories: value.categories } : {}),
    },
  };
}

/** Parse a transfer payload from a UTF-8 string or byte array. */
export function parseProfileTransferBytes(
  input: string | Uint8Array,
): ProfileTransferParseResult {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  return parseProfileTransfer(bytes);
}
