import type {
  NormalizedProfilesFile,
  ProfileFragment,
} from './profileValidation.js';
import type { Profile } from './schema.js';

const PROFILE_SOURCE_EXTENSION = /(?:\.profile\.jsonc|\.profile\.json|\.jsonc|\.json)$/iu;
const UNSAFE_FILENAME_CHARACTERS = /[<>:"/\\|?*\p{Cc}]+/gu;
const TRAILING_FILENAME_CHARACTERS = /[. ]+$/gu;
const WINDOWS_DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/iu;

export function serializeProfileTransfer(
  value: ProfileFragment | NormalizedProfilesFile,
): string {
  return `${JSON.stringify(value, null, 2)}\n`;
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

export function deriveProfileNameFromSource(sourceName: string): string {
  const profileName = sourceName
    .trim()
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
    .replace(UNSAFE_FILENAME_CHARACTERS, '-')
    .replace(TRAILING_FILENAME_CHARACTERS, '');
  if (sanitized.trim() === '') return 'profile';

  const deviceStem = (sanitized.split('.', 1)[0] ?? '').trimEnd();
  return WINDOWS_DEVICE_NAME.test(deviceStem)
    ? `profile-${sanitized}`
    : sanitized;
}

export function containsProviderOptions(fragment: ProfileFragment): boolean {
  if (fragment.agents === undefined) return false;

  return Object.values(fragment.agents).some((agent) => {
    if (!Object.hasOwn(agent, 'providerOptions')) return false;
    const providerOptions = agent.providerOptions;
    return providerOptions !== undefined && Object.keys(providerOptions).length > 0;
  });
}
