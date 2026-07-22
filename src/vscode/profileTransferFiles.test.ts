import { beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeMocks = vi.hoisted(() => ({
  temporaryUuid: '123e4567-e89b-42d3-a456-426614174000',
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
} from './profileTransferFiles.js';

function installFileSystemHarness(
  target: vscode.Uri,
  initialBytes: Uint8Array,
) {
  const files = new Map([[target.toString(), initialBytes]]);
  const order: string[] = [];
  let bytesBeforeRename: Uint8Array | undefined;

  vi.mocked(vscode.workspace.fs.writeFile).mockImplementation(
    async (uri, bytes) => {
      order.push(`write:${uri.toString()}`);
      files.set(uri.toString(), bytes);
    },
  );
  vi.mocked(vscode.workspace.fs.rename).mockImplementation(
    async (source, destination) => {
      order.push(`rename:${source.toString()}->${destination.toString()}`);
      bytesBeforeRename = files.get(destination.toString());
      const bytes = files.get(source.toString());
      if (bytes !== undefined) {
        files.set(destination.toString(), bytes);
        files.delete(source.toString());
      }
    },
  );
  vi.mocked(vscode.workspace.fs.delete).mockImplementation(async (uri) => {
    order.push(`delete:${uri.toString()}`);
    files.delete(uri.toString());
  });

  return {
    files,
    order,
    destinationBeforeRename: () => bytesBeforeRename,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('openTransferFile', () => {
  it('reads the bytes from the single selected non-file URI', async () => {
    // Given: a single remote resource selected by the open dialog
    const uri = vscode.Uri.parse('memfs://remote/profiles/input.profile.json');
    const bytes = Uint8Array.from([0, 1, 127, 255]);
    vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([uri]);
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(bytes);

    // When: the transfer file is opened
    const result = await openTransferFile({ title: 'Choose profile data' });

    // Then: the exact URI and bytes are returned through the typed result
    expect(result).toEqual({ status: 'success', value: { uri, bytes } });
    expect(vscode.window.showOpenDialog).toHaveBeenCalledWith({
      title: 'Choose profile data',
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
    });
    expect(vscode.workspace.fs.readFile).toHaveBeenCalledWith(uri);
  });

  it('returns typed cancellation without reading when the dialog is dismissed', async () => {
    // Given: a dismissed open dialog
    vi.mocked(vscode.window.showOpenDialog).mockResolvedValue(undefined);

    // When: the transfer file is opened
    const result = await openTransferFile();

    // Then: cancellation is a no-op and no filesystem operation occurs
    expect(result).toEqual({ status: 'cancelled' });
    expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled();
  });

  it('returns a typed selection error for an unsupported multi-URI result', async () => {
    // Given: a malformed dialog result that violates single-selection mode
    const first = vscode.Uri.parse('memfs://remote/first.json');
    const second = vscode.Uri.parse('memfs://remote/second.json');
    vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([first, second]);

    // When: the transfer file is opened
    const result = await openTransferFile();

    // Then: the malformed selection is rejected before filesystem access
    expect(result).toMatchObject({
      status: 'error',
      error: { operation: 'open-selection' },
    });
    expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled();
  });

  it('returns a typed read error with the original cause', async () => {
    // Given: a selected URI whose provider rejects the read
    const uri = vscode.Uri.parse('memfs://remote/unreadable.json');
    const cause = new Error('provider read failed');
    vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([uri]);
    vi.mocked(vscode.workspace.fs.readFile).mockRejectedValue(cause);

    // When: the transfer file is opened
    const result = await openTransferFile();

    // Then: the infrastructure failure is typed and retains its cause
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error).toBeInstanceOf(ProfileTransferFileError);
      expect(result.error).toMatchObject({ operation: 'read', cause });
    }
  });
});

describe('saveTransferFile', () => {
  it('writes a sibling temp URI before overwrite-renaming exact bytes', async () => {
    // Given: a remote destination containing prior bytes
    const target = vscode.Uri.parse(
      'memfs://remote/profiles/output.profile.json?workspace=alpha#selection',
    );
    const oldBytes = Uint8Array.from([9, 9]);
    const newBytes = Uint8Array.from([0, 16, 128, 255]);
    const harness = installFileSystemHarness(target, oldBytes);
    vi.mocked(vscode.window.showSaveDialog).mockImplementation(async () => {
      harness.order.push('showSaveDialog');
      return target;
    });

    // When: the payload is saved
    const result = await saveTransferFile(newBytes, { title: 'Save profile data' });

    // Then: destination replacement is atomic, URI-native, and residue-free
    const [[temporaryUri, writtenBytes]] = vi.mocked(
      vscode.workspace.fs.writeFile,
    ).mock.calls;
    expect(result).toEqual({ status: 'success', value: target });
    expect(writtenBytes).toEqual(newBytes);
    expect(temporaryUri).toMatchObject({
      scheme: 'memfs',
      authority: 'remote',
      query: '',
      fragment: '',
    });
    expect(temporaryUri.path).toBe(
      `/profiles/output.profile.json.${vscodeMocks.temporaryUuid}.tmp`,
    );
    expect(vscode.workspace.fs.rename).toHaveBeenCalledWith(
      temporaryUri,
      target,
      { overwrite: true },
    );
    expect(vscode.window.showSaveDialog).toHaveBeenCalledWith({
      title: 'Save profile data',
    });
    expect(harness.destinationBeforeRename()).toEqual(oldBytes);
    expect(harness.files.get(target.toString())).toEqual(newBytes);
    expect(harness.files.has(temporaryUri.toString())).toBe(false);
    expect(harness.order).toEqual([
      'showSaveDialog',
      `write:${temporaryUri.toString()}`,
      `rename:${temporaryUri.toString()}->${target.toString()}`,
    ]);
  });

  it('returns typed cancellation without writing when the dialog is dismissed', async () => {
    // Given: a dismissed save dialog
    vi.mocked(vscode.window.showSaveDialog).mockResolvedValue(undefined);

    // When: the payload is saved
    const result = await saveTransferFile(Uint8Array.from([1]));

    // Then: cancellation is a no-op and no filesystem operation occurs
    expect(result).toEqual({ status: 'cancelled' });
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.rename).not.toHaveBeenCalled();
  });

  it('cleans the temp URI and preserves the destination after write failure', async () => {
    // Given: a provider that rejects the temporary write
    const target = vscode.Uri.parse('memfs://remote/profiles/output.json');
    const oldBytes = Uint8Array.from([7]);
    vi.mocked(vscode.window.showSaveDialog).mockResolvedValue(target);
    const harness = installFileSystemHarness(target, oldBytes);
    const cause = new Error('provider write failed');
    vi.mocked(vscode.workspace.fs.writeFile).mockImplementationOnce(
      async (uri) => {
        harness.order.push(`write:${uri.toString()}`);
        harness.files.set(uri.toString(), Uint8Array.from([8]));
        throw cause;
      },
    );

    // When: the payload is saved
    const result = await saveTransferFile(Uint8Array.from([8]));

    // Then: the original error wins, destination is untouched, and no temp remains
    const [[temporaryUri]] = vi.mocked(vscode.workspace.fs.writeFile).mock.calls;
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error).toMatchObject({ operation: 'write', cause });
    }
    expect(vscode.workspace.fs.rename).not.toHaveBeenCalled();
    expect(harness.files.get(target.toString())).toEqual(oldBytes);
    expect(harness.files.has(temporaryUri.toString())).toBe(false);
    expect(harness.order).toEqual([
      `write:${temporaryUri.toString()}`,
      `delete:${temporaryUri.toString()}`,
    ]);
  });

  it('cleans the temp URI and preserves the destination after rename failure', async () => {
    // Given: a successful temp write followed by a rejected atomic rename
    const target = vscode.Uri.parse('memfs://remote/profiles/output.json');
    const oldBytes = Uint8Array.from([4]);
    vi.mocked(vscode.window.showSaveDialog).mockResolvedValue(target);
    const harness = installFileSystemHarness(target, oldBytes);
    const cause = new Error('provider rename failed');
    vi.mocked(vscode.workspace.fs.rename).mockImplementationOnce(
      async (source, destination) => {
        harness.order.push(
          `rename:${source.toString()}->${destination.toString()}`,
        );
        throw cause;
      },
    );

    // When: the payload is saved
    const result = await saveTransferFile(Uint8Array.from([5]));

    // Then: the original error wins, destination is untouched, and no temp remains
    const [[temporaryUri]] = vi.mocked(vscode.workspace.fs.writeFile).mock.calls;
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error).toMatchObject({ operation: 'rename', cause });
    }
    expect(harness.files.get(target.toString())).toEqual(oldBytes);
    expect(harness.files.has(temporaryUri.toString())).toBe(false);
    expect(harness.order).toEqual([
      `write:${temporaryUri.toString()}`,
      `rename:${temporaryUri.toString()}->${target.toString()}`,
      `delete:${temporaryUri.toString()}`,
    ]);
  });

  it('retains the rename cause when best-effort cleanup also fails', async () => {
    // Given: both the atomic rename and subsequent cleanup reject
    const target = vscode.Uri.parse('memfs://remote/profiles/output.json');
    vi.mocked(vscode.window.showSaveDialog).mockResolvedValue(target);
    const harness = installFileSystemHarness(target, Uint8Array.from([2]));
    const renameCause = new Error('provider rename failed');
    vi.mocked(vscode.workspace.fs.rename).mockRejectedValue(renameCause);
    vi.mocked(vscode.workspace.fs.delete).mockRejectedValue(
      new Error('provider cleanup failed'),
    );

    // When: the payload is saved
    const result = await saveTransferFile(Uint8Array.from([3]));

    // Then: cleanup cannot replace the original typed rename failure
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error).toMatchObject({
        operation: 'rename',
        cause: renameCause,
      });
    }
    expect(vscode.workspace.fs.delete).toHaveBeenCalledOnce();
    expect(harness.files.get(target.toString())).toEqual(Uint8Array.from([2]));
  });
});
