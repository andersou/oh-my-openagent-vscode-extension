import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';

export type ProfileTransferFileOperation =
  | 'open-dialog'
  | 'open-selection'
  | 'read'
  | 'save-dialog'
  | 'write'
  | 'rename';

export type TransferFileResult<T> =
  | { readonly status: 'success'; readonly value: T }
  | { readonly status: 'cancelled' }
  | { readonly status: 'error'; readonly error: ProfileTransferFileError };

export type OpenedTransferFile = {
  readonly uri: vscode.Uri;
  readonly bytes: Uint8Array;
};

export type OpenTransferFileOptions = Omit<
  vscode.OpenDialogOptions,
  'canSelectFiles' | 'canSelectFolders' | 'canSelectMany'
>;

export class ProfileTransferFileError extends Error {
  override readonly name = 'ProfileTransferFileError';

  constructor(
    readonly operation: ProfileTransferFileOperation,
    readonly uri: vscode.Uri | undefined,
    cause?: unknown,
  ) {
    super(`Profile transfer file operation failed during ${operation}.`, {
      cause,
    });
  }
}

const CANCELLED = { status: 'cancelled' } as const;

export async function openTransferFile(
  options: OpenTransferFileOptions = {},
): Promise<TransferFileResult<OpenedTransferFile>> {
  let selected: vscode.Uri[] | undefined;
  try {
    selected = await vscode.window.showOpenDialog({
      ...options,
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
    });
  } catch (cause) {
    return {
      status: 'error',
      error: new ProfileTransferFileError('open-dialog', undefined, cause),
    };
  }

  if (selected === undefined) {
    return CANCELLED;
  }
  if (selected.length !== 1) {
    return {
      status: 'error',
      error: new ProfileTransferFileError(
        'open-selection',
        undefined,
        selected.length,
      ),
    };
  }

  const [uri] = selected;
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return { status: 'success', value: { uri, bytes } };
  } catch (cause) {
    return {
      status: 'error',
      error: new ProfileTransferFileError('read', uri, cause),
    };
  }
}

export async function saveTransferFile(
  bytes: Uint8Array,
  options: vscode.SaveDialogOptions = {},
): Promise<TransferFileResult<vscode.Uri>> {
  let target: vscode.Uri | undefined;
  try {
    target = await vscode.window.showSaveDialog(options);
  } catch (cause) {
    return {
      status: 'error',
      error: new ProfileTransferFileError('save-dialog', undefined, cause),
    };
  }

  if (target === undefined) {
    return CANCELLED;
  }

  const temporaryUri = target.with({
    path: `${target.path}.${randomUUID()}.tmp`,
    query: '',
    fragment: '',
  });

  try {
    await vscode.workspace.fs.writeFile(temporaryUri, bytes);
  } catch (cause) {
    await deleteTemporaryUri(temporaryUri);
    return {
      status: 'error',
      error: new ProfileTransferFileError('write', temporaryUri, cause),
    };
  }

  try {
    await vscode.workspace.fs.rename(temporaryUri, target, { overwrite: true });
  } catch (cause) {
    await deleteTemporaryUri(temporaryUri);
    return {
      status: 'error',
      error: new ProfileTransferFileError('rename', temporaryUri, cause),
    };
  }

  return { status: 'success', value: target };
}

async function deleteTemporaryUri(uri: vscode.Uri): Promise<void> {
  await Promise.allSettled([
    vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false }),
  ]);
}
