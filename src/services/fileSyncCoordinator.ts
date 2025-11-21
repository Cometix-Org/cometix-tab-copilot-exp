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

const MAX_VERSION_LAG = 10;
const SYNC_DEBOUNCE_MS = 250;

export class FileSyncCoordinator implements vscode.Disposable {
  private readonly syncedVersions = new Map<string, number>();
  private readonly pendingFlushes = new Map<string, NodeJS.Timeout>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly rpc: RpcClient,
    private readonly logger: Logger,
    private readonly updates: FilesyncUpdatesStore,
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => this.onDocumentChanged(event.document)),
      vscode.window.onDidChangeVisibleTextEditors((editors) => this.onVisibleEditorsChanged(editors)),
      vscode.workspace.onDidCloseTextDocument((document) => this.onDocumentClosed(document)),
    );

    void this.syncVisibleEditors(vscode.window.visibleTextEditors);
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.pendingFlushes.forEach((timer) => clearTimeout(timer));
    this.pendingFlushes.clear();
    this.syncedVersions.clear();
  }

  async prepareDocument(document: vscode.TextDocument): Promise<void> {
    if (!this.isTrackableDocument(document)) {
      return;
    }
    await this.ensureUploaded(document);
    await this.flushIncremental(document);
  }

  getUpdatesForRequest(document: vscode.TextDocument): FilesyncUpdateWithModelVersion[] {
    if (!this.isTrackableDocument(document)) {
      return [];
    }
    const key = document.uri.toString();
    const version = this.syncedVersions.get(key) ?? 0;
    return this.updates.getUpdates(document.uri, version);
  }

  getSyncPayload(document: vscode.TextDocument): {
    relyOnFileSync: boolean;
    updates: FilesyncUpdateWithModelVersion[];
  } {
    if (!this.isTrackableDocument(document)) {
      return { relyOnFileSync: false, updates: [] };
    }
    const relyOnFileSync = this.shouldRelyOnFileSync(document);
    const updates = relyOnFileSync ? this.getUpdatesForRequest(document) : [];
    return { relyOnFileSync, updates };
  }

  shouldRelyOnFileSync(document: vscode.TextDocument): boolean {
    if (!this.isTrackableDocument(document)) {
      return false;
    }
    const key = document.uri.toString();
    const syncedVersion = this.syncedVersions.get(key);
    if (syncedVersion === undefined) {
      return false;
    }
    return document.version - syncedVersion <= MAX_VERSION_LAG;
  }

  private async ensureUploaded(document: vscode.TextDocument): Promise<void> {
    if (!this.isTrackableDocument(document)) {
      return;
    }
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
    if (!this.isTrackableDocument(document)) {
      return;
    }
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

  private isTrackableDocument(document: vscode.TextDocument): boolean {
    return document.uri.scheme === 'file';
  }

  private onDocumentChanged(document: vscode.TextDocument): void {
    if (!this.isTrackableDocument(document)) {
      return;
    }
    this.scheduleSync(document);
  }

  private onVisibleEditorsChanged(editors: readonly vscode.TextEditor[]): void {
    for (const editor of editors) {
      if (this.isTrackableDocument(editor.document)) {
        this.scheduleSync(editor.document, 0);
      }
    }
  }

  private onDocumentClosed(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    this.syncedVersions.delete(key);
    const pending = this.pendingFlushes.get(key);
    if (pending) {
      clearTimeout(pending);
      this.pendingFlushes.delete(key);
    }
  }

  private scheduleSync(document: vscode.TextDocument, debounce = SYNC_DEBOUNCE_MS): void {
    const key = document.uri.toString();
    const pending = this.pendingFlushes.get(key);
    if (pending) {
      clearTimeout(pending);
    }
    const timer = setTimeout(() => {
      this.pendingFlushes.delete(key);
      this.prepareDocument(document).catch((error) => {
        this.logger.error(`Failed to sync ${document.uri.fsPath}`, error);
      });
    }, debounce);
    this.pendingFlushes.set(key, timer);
  }

  private async syncVisibleEditors(editors: readonly vscode.TextEditor[]): Promise<void> {
    for (const editor of editors) {
      if (this.isTrackableDocument(editor.document)) {
        await this.prepareDocument(editor.document);
      }
    }
  }
}
