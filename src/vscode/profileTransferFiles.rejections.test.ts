import { beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeMocks = vi.hoisted(() => ({
  temporaryUuid: '123e4567-e89b-42d3-a456-426614174001',
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('node:crypto', () => ({
  randomUUID: () => vscodeMocks.temporaryUuid,
}));

vi.mock('vscode', async () => {
  const { MockUri } = await import('./profileTransferFiles.testMock.js');
  return {
    Uri: MockUri,
    window: {
      showOpenDialog: vscodeMocks.showOpenDialog,
      showSaveDialog: vscodeMocks.showSaveDialog,
    },
    workspace: {
      fs: {
        readFile: vscodeMocks.readFile,
        writeFile: vscodeMocks.writeFile,
        rename: vscodeMocks.rename,
        delete: vscodeMocks.delete,
      },
    },
  };
});

import * as vscode from 'vscode';
import {
  openTransferFile,
  ProfileTransferFileError,
  saveTransferFile,
  type ProfileTransferFileOperation,
  type TransferFileResult,
} from './profileTransferFiles.js';

function expectTypedFailure<T>(
  result: TransferFileResult<T>,
  operation: ProfileTransferFileOperation,
  cause: unknown,
): void {
  expect(result.status).toBe('error');
  if (result.status === 'error') {
    expect(result.error).toBeInstanceOf(ProfileTransferFileError);
    expect(result.error.operation).toBe(operation);
    expect(result.error.cause).toBe(cause);
  }
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('profile transfer primitive rejection contract', () => {
  it('wraps a primitive open-dialog rejection', async () => {
    // Given: the open dialog rejects with a non-Error cause
    const cause = 'open dialog rejected';
    vi.mocked(vscode.window.showOpenDialog).mockRejectedValue(cause);

    // When: a transfer file is opened
    const result = await openTransferFile();

    // Then: the primitive is retained in the typed result
    expectTypedFailure(result, 'open-dialog', cause);
    expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled();
  });

  it('wraps a primitive read rejection', async () => {
    // Given: the selected URI provider rejects readFile with a number
    const uri = vscode.Uri.parse('memfs://remote/profiles/input.json');
    const cause = 404;
    vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([uri]);
    vi.mocked(vscode.workspace.fs.readFile).mockRejectedValue(cause);

    // When: a transfer file is opened
    const result = await openTransferFile();

    // Then: the primitive is retained in the typed read failure
    expectTypedFailure(result, 'read', cause);
  });

  it('wraps a primitive save-dialog rejection', async () => {
    // Given: the save dialog rejects with a boolean
    const cause = false;
    vi.mocked(vscode.window.showSaveDialog).mockRejectedValue(cause);

    // When: bytes are saved
    const result = await saveTransferFile(Uint8Array.from([1]));

    // Then: the primitive is retained and no filesystem call occurs
    expectTypedFailure(result, 'save-dialog', cause);
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });

  it('cleans up after a primitive write rejection without replacing its cause', async () => {
    // Given: a partial temp write and cleanup both reject with primitive causes
    const target = vscode.Uri.parse('memfs://remote/profiles/output.json');
    const cause = 'write rejected';
    vi.mocked(vscode.window.showSaveDialog).mockResolvedValue(target);
    vi.mocked(vscode.workspace.fs.writeFile).mockRejectedValue(cause);
    vi.mocked(vscode.workspace.fs.delete).mockRejectedValue('cleanup rejected');

    // When: bytes are saved
    const result = await saveTransferFile(Uint8Array.from([2]));

    // Then: cleanup is attempted and the write cause remains authoritative
    const [[temporaryUri]] = vi.mocked(vscode.workspace.fs.writeFile).mock.calls;
    const [writeOrder] = vi.mocked(vscode.workspace.fs.writeFile).mock
      .invocationCallOrder;
    const [deleteOrder] = vi.mocked(vscode.workspace.fs.delete).mock
      .invocationCallOrder;
    expectTypedFailure(result, 'write', cause);
    expect(writeOrder).toBeLessThan(deleteOrder);
    expect(vscode.workspace.fs.delete).toHaveBeenCalledWith(temporaryUri, {
      recursive: false,
      useTrash: false,
    });
    expect(vscode.workspace.fs.rename).not.toHaveBeenCalled();
  });

  it('cleans up after a primitive rename rejection without replacing its cause', async () => {
    // Given: temp write succeeds before rename rejects with null
    const target = vscode.Uri.parse('memfs://remote/profiles/output.json');
    const cause = null;
    vi.mocked(vscode.window.showSaveDialog).mockResolvedValue(target);
    vi.mocked(vscode.workspace.fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.fs.rename).mockRejectedValue(cause);
    vi.mocked(vscode.workspace.fs.delete).mockResolvedValue(undefined);

    // When: bytes are saved
    const result = await saveTransferFile(Uint8Array.from([3]));

    // Then: cleanup follows rename and the exact target identity is preserved
    const [[temporaryUri]] = vi.mocked(vscode.workspace.fs.writeFile).mock.calls;
    const [writeOrder] = vi.mocked(vscode.workspace.fs.writeFile).mock
      .invocationCallOrder;
    const [renameOrder] = vi.mocked(vscode.workspace.fs.rename).mock
      .invocationCallOrder;
    const [deleteOrder] = vi.mocked(vscode.workspace.fs.delete).mock
      .invocationCallOrder;
    expectTypedFailure(result, 'rename', cause);
    expect(writeOrder).toBeLessThan(renameOrder);
    expect(renameOrder).toBeLessThan(deleteOrder);
    expect(vscode.workspace.fs.rename).toHaveBeenCalledWith(
      temporaryUri,
      target,
      { overwrite: true },
    );
    expect(vscode.workspace.fs.delete).toHaveBeenCalledWith(temporaryUri, {
      recursive: false,
      useTrash: false,
    });
  });
});
