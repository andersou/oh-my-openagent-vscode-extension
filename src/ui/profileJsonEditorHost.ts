import type { ConfigStore } from '../config/configStore.js';
import {
  parseProfileTransferBytes,
  serializeProfileTransfer,
  type UnvalidatedProfileFragmentRoot,
} from '../config/profileTransfer.js';
import type { ProfileStore } from '../config/profileStore.js';
import {
  validateProfileTransfer,
  type ProfileFragment,
} from '../config/profileValidation.js';

export type ProfileJsonTarget =
  | { type: 'profileJson'; source: 'active' }
  | { type: 'profileJson'; source: 'saved'; profile: string };

export function parseProfileJsonTarget(raw: unknown): ProfileJsonTarget | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const target = raw as { type?: unknown; source?: unknown; profile?: unknown };
  if (target.type !== 'profileJson') {
    return undefined;
  }
  if (target.source === 'active') {
    return { type: 'profileJson', source: 'active' };
  }
  if (target.source === 'saved' && typeof target.profile === 'string') {
    return { type: 'profileJson', source: 'saved', profile: target.profile };
  }
  return undefined;
}

function isSavedProfileJsonTarget(
  target: ProfileJsonTarget,
): target is Extract<ProfileJsonTarget, { source: 'saved' }> {
  return target.source === 'saved';
}

function sameProfileJsonTarget(left: ProfileJsonTarget, right: ProfileJsonTarget): boolean {
  if (left.source !== right.source) {
    return false;
  }
  if (isSavedProfileJsonTarget(left) && isSavedProfileJsonTarget(right)) {
    return left.profile === right.profile;
  }
  return true;
}

function buildActiveFragment(configStore: ConfigStore): ProfileFragment {
  const config = configStore.getConfig();
  return {
    ...(config.agents === undefined ? {} : { agents: config.agents }),
    ...(config.categories === undefined ? {} : { categories: config.categories }),
  };
}

export function getProfileJsonInitText(
  target: ProfileJsonTarget,
  profileStore: ProfileStore,
  configStore: ConfigStore,
): string {
  const fragment: ProfileFragment =
    target.source === 'active'
      ? buildActiveFragment(configStore)
      : profileStore.getProfileFragment(target.profile);
  return serializeProfileTransfer(fragment);
}

export interface ProfileJsonSaveSuccess {
  readonly ok: true;
  readonly canonicalText: string;
}

export interface ProfileJsonSaveFailure {
  readonly ok: false;
  readonly message: string;
}

export type ProfileJsonSaveResult = ProfileJsonSaveSuccess | ProfileJsonSaveFailure;

export async function saveProfileJson(
  target: ProfileJsonTarget,
  rawText: string,
  profileStore: ProfileStore,
  configStore: ConfigStore,
): Promise<ProfileJsonSaveResult> {
  const parseResult = parseProfileTransferBytes(rawText);
  if (!parseResult.ok) {
    return { ok: false, message: parseResult.error.message };
  }
  if (parseResult.root.kind !== 'fragment') {
    return { ok: false, message: 'Expected a profile fragment (agents/categories)' };
  }

  const validateResult = validateProfileTransfer(
    parseResult.root as UnvalidatedProfileFragmentRoot,
  );
  if (!validateResult.ok) {
    return { ok: false, message: validateResult.error.message };
  }
  if (validateResult.value.kind !== 'fragment') {
    return { ok: false, message: 'Expected a profile fragment (agents/categories)' };
  }
  const fragment = validateResult.value.value;
  const canonicalText = serializeProfileTransfer(fragment);

  try {
    if (target.source === 'active') {
      await profileStore.replaceActiveConfigFragment(fragment);
    } else {
      const activeName = profileStore.getActiveProfileName();
      if (activeName === target.profile) {
        await profileStore.replaceActiveConfigFragment(fragment);
        try {
          await profileStore.saveActiveConfigToProfile();
        } catch (err: unknown) {
          const reason = err instanceof Error ? err.message : String(err);
          return {
            ok: false,
            message: `Saved to active config but failed to snapshot profile: ${reason}`,
          };
        }
      } else {
        await profileStore.replaceProfileFragment(target.profile, fragment);
      }
    }
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, message: reason };
  }

  return { ok: true, canonicalText };
}

export function profileJsonTargetMatches(
  incoming: ProfileJsonTarget,
  current: ProfileJsonTarget,
): boolean {
  return sameProfileJsonTarget(incoming, current);
}
