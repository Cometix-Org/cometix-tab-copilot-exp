import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { RpcClient } from './rpcClient';
import { Logger } from './logger';
import {
  FSUploadFileRequest,
  FSSyncFileRequest,
  FilesyncUpdateWithModelVersion,
} from '../rpc/cursor-tab_pb';
import { FilesyncUpdatesStore } from './filesyncUpdatesStore';

export class FileSyncCoordinator implements vscode.Disposable {
  private readonly syncedVersions = new Map<string, number>();

  constructor(
    private readonly rpc: RpcClient,
    private readonly logger: Logger,
    private readonly updates: FilesyncUpdatesStore,
  ) {}

  dispose(): void {
    this.syncedVersions.clear();
  }

  async prepareDocument(document: vscode.TextDocument): Promise<void> {
    await this.ensureUploaded(document);
    await this.flushIncremental(document);
  }

  getUpdatesForRequest(document: vscode.TextDocument): FilesyncUpdateWithModelVersion[] {
    const key = document.uri.toString();
    const version = this.syncedVersions.get(key) ?? 0;
    return this.updates.getUpdates(document.uri, version);
  }

  private async ensureUploaded(document: vscode.TextDocument): Promise<void> {
    const key = document.uri.toString();
    if (this.syncedVersions.has(key)) {
      return;
    }
    const relative = vscode.workspace.asRelativePath(document.uri, false);
    const hash = this.hash(document.getText());
    const request = new FSUploadFileRequest({
      uuid: key,
      relativeWorkspacePath: relative,
      contents: document.getText(),
      modelVersion: document.version,
      sha256Hash: hash,
    });
    try {
      await this.rpc.uploadFile(request);
      this.syncedVersions.set(key, document.version);
      this.updates.dropThrough(document.uri, document.version);
      this.logger.info(`Uploaded ${relative} to Cursor backend`);
    } catch (error) {
      this.logger.error(`Failed to upload ${relative}`, error);
    }
  }

  private async flushIncremental(document: vscode.TextDocument): Promise<void> {
    const key = document.uri.toString();
    const lastSynced = this.syncedVersions.get(key) ?? 0;
    const pending = this.updates.getUpdates(document.uri, lastSynced);
    if (!pending.length) {
      return;
    }
    const highest = pending[pending.length - 1].modelVersion;
    const request = new FSSyncFileRequest({
      uuid: key,
      relativeWorkspacePath: vscode.workspace.asRelativePath(document.uri, false),
      modelVersion: highest,
      filesyncUpdates: pending,
      sha256Hash: this.hash(document.getText()),
    });
    try {
      await this.rpc.syncFile(request);
      this.syncedVersions.set(key, highest);
      this.updates.dropThrough(document.uri, highest);
      this.logger.info(`Synced ${pending.length} update(s) for ${request.relativeWorkspacePath}`);
    } catch (error) {
      this.logger.error('Failed to sync incremental updates', error);
    }
  }

  private hash(contents: string): string {
    return createHash('sha256').update(contents).digest('hex');
  }
}
