import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { IRpcClient, ILogger, IFileSyncCoordinator } from '../context/contracts';
import {
  FSUploadFileRequest,
  FSSyncFileRequest,
  FilesyncUpdateWithModelVersion,
  SingleUpdateRequest,
} from '../rpc/cursor-tab_pb';
import { FilesyncUpdatesStore } from './filesyncUpdatesStore';

const MAX_VERSION_LAG = 10;
const MAX_VERSION_DRIFT = 100;
// Reduced from 5 to 2 for faster initial completion availability
// The server requires a few successful syncs before accepting relyOnFileSync=true
const SUCCESS_THRESHOLD = 2;
const CATCHUP_RETRIES = 8;
const CATCHUP_DELAY_MS = 4;
const SYNC_DEBOUNCE_MS = 250;

export class FileSyncCoordinator implements vscode.Disposable, IFileSyncCoordinator {
  private readonly syncedVersions = new Map<string, number>();
  private readonly sequentialSuccess = new Map<string, number>();
  private readonly pendingFlushes = new Map<string, NodeJS.Timeout>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly rpc: IRpcClient,
    private readonly logger: ILogger,
    private readonly updates: FilesyncUpdatesStore,
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => this.onDocumentChanged(event)),
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
    const key = document.uri.toString();
    const queued = this.updates.getUpdates(document.uri, -1).length;
    this.logger.info(
      `Preparing ${this.describeDocument(document)} for sync (queuedUpdates=${queued}, lastSynced=${
        this.syncedVersions.get(key) ?? 0
      })`,
    );
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
    // Per Cursor's implementation: only include filesyncUpdates when relyOnFileSync is true
    // When relyOnFileSync is false, send full contents with NO updates
    if (!relyOnFileSync) {
      return { relyOnFileSync: false, updates: [] };
    }
    const updates = this.waitForQueuedUpdates(document);
    if (!updates) {
      return { relyOnFileSync: false, updates: [] };
    }
    return { relyOnFileSync: true, updates };
  }

  shouldRelyOnFileSync(document: vscode.TextDocument): boolean {
    if (!this.isTrackableDocument(document)) {
      return false;
    }
    const key = document.uri.toString();
    const syncedVersion = this.syncedVersions.get(key);
    const successes = this.sequentialSuccess.get(key) ?? 0;
    if (syncedVersion === undefined) {
      return false;
    }
    return (
      document.version - syncedVersion <= MAX_VERSION_LAG &&
      successes >= SUCCESS_THRESHOLD
    );
  }

  private async ensureUploaded(document: vscode.TextDocument, force = false, reason?: string): Promise<void> {
    if (!this.isTrackableDocument(document)) {
      return;
    }
    const key = document.uri.toString();
    if (!force && this.syncedVersions.has(key)) {
      return;
    }
    const relative = vscode.workspace.asRelativePath(document.uri, false);
    const hash = this.hash(document.getText());
    this.logger.info(
      `Uploading ${relative} (version=${document.version}, force=${force}${
        reason ? `, reason=${reason}` : ''
      }, hash=${hash.slice(0, 8)}..., queuedUpdates=${this.updates.getUpdates(document.uri, -1).length})`,
    );
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
      this.sequentialSuccess.set(key, 1);
      this.updates.dropThrough(document.uri, document.version);
      this.logger.info(
        `Uploaded ${relative} to Cursor backend (version=${document.version}, lastSynced=${this.syncedVersions.get(
          key,
        )}, queueCleared=${this.updates.getUpdates(document.uri, document.version).length === 0})`,
      );
    } catch (error) {
      this.sequentialSuccess.delete(key);
      this.logger.error(`Failed to upload ${relative} (version=${document.version})`, error);
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
    const relative = vscode.workspace.asRelativePath(document.uri, false);
    const fallbackReason = this.getFallbackReason(lastSynced, highest);
    this.logger.info(
      `Attempting incremental sync for ${relative} (pending=${pending.length}, lastSynced=${lastSynced}, highest=${highest}, docVersion=${document.version}, queuedTotal=${this.updates.getUpdates(document.uri, -1).length}) :: ${this.describeUpdates(pending)}`,
    );
    if (fallbackReason) {
      this.logger.info(
        `Falling back to full upload for ${relative} (lastSynced=${lastSynced}, highest=${highest}) :: ${fallbackReason}`,
      );
      await this.ensureUploaded(document, true, fallbackReason);
      return;
    }
    const request = new FSSyncFileRequest({
      uuid: key,
      relativeWorkspacePath: relative,
      modelVersion: highest,
      filesyncUpdates: pending,
      sha256Hash: this.hash(document.getText()),
    });
    try {
      await this.rpc.syncFile(request);
      this.syncedVersions.set(key, highest);
      const current = this.sequentialSuccess.get(key) ?? 0;
      this.sequentialSuccess.set(key, current + 1);
      this.updates.dropThrough(document.uri, highest);
      this.logger.info(
        `Synced ${pending.length} update(s) for ${request.relativeWorkspacePath} -> v${highest} (docVersion=${document.version}, lastSynced=${lastSynced}, sequentialSuccess=${current + 1})`,
      );
    } catch (error) {
      this.sequentialSuccess.delete(key);
      this.logger.error(
        `Failed to sync incremental updates for ${relative} (pending=${pending.length}, lastSynced=${lastSynced}, highest=${highest})`,
        error,
      );
    }
  }

  private hash(contents: string): string {
    return createHash('sha256').update(contents).digest('hex');
  }

  private isTrackableDocument(document: vscode.TextDocument): boolean {
    if (document.uri.scheme !== 'file') {
      return false;
    }

    const fsPath = document.uri.fsPath;
    // Never sync VS Code server/user configuration files (may contain secrets).
    if (fsPath.includes('/.vscode-server/') || fsPath.includes('/.vscode/')) {
      return false;
    }

    // If a workspace is open, only sync files inside workspace folders.
    if (vscode.workspace.workspaceFolders?.length) {
      return vscode.workspace.getWorkspaceFolder(document.uri) !== undefined;
    }

    return true;
  }

  private onDocumentChanged(event: vscode.TextDocumentChangeEvent): void {
    if (!this.isTrackableDocument(event.document)) {
      return;
    }
    const changeDetails = event.contentChanges
      .map((change, index) => {
        const start = `${change.range.start.line + 1}:${change.range.start.character + 1}`;
        const end = `${change.range.end.line + 1}:${change.range.end.character + 1}`;
        const delta = change.text.length - change.rangeLength;
        const preview = this.truncate(change.text, 80);
        return `#${index + 1} ${start}-${end} delta=${delta} text="${preview}"`;
      })
      .join('; ');
    this.scheduleSync(
      event.document,
      SYNC_DEBOUNCE_MS,
      `text change (${event.contentChanges.length} change(s)) :: ${changeDetails}`,
    );
  }

  private onVisibleEditorsChanged(editors: readonly vscode.TextEditor[]): void {
    for (const editor of editors) {
      if (this.isTrackableDocument(editor.document)) {
        this.scheduleSync(editor.document, 0, 'visible editor activated');
      }
    }
  }

  private onDocumentClosed(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    this.syncedVersions.delete(key);
    this.sequentialSuccess.delete(key);
    const pending = this.pendingFlushes.get(key);
    if (pending) {
      clearTimeout(pending);
      this.pendingFlushes.delete(key);
    }
  }

  private scheduleSync(document: vscode.TextDocument, debounce = SYNC_DEBOUNCE_MS, reason = 'unknown'): void {
    const key = document.uri.toString();
    const pending = this.pendingFlushes.get(key);
    if (pending) {
      clearTimeout(pending);
    }
    const relative = vscode.workspace.asRelativePath(document.uri, false);
    this.logger.info(
      `Scheduled sync for ${relative} (version=${document.version}, debounce=${debounce}ms, reason=${reason}, queuedUpdates=${this.updates.getUpdates(document.uri, -1).length})`,
    );
    const timer = setTimeout(() => {
      this.pendingFlushes.delete(key);
      this.logger.info(`Starting sync for ${relative} (version=${document.version}, reason=${reason})`);
      this.prepareDocument(document).catch((error) => {
        this.logger.error(`Failed to sync ${document.uri.fsPath} (reason=${reason})`, error);
      });
    }, debounce);
    this.pendingFlushes.set(key, timer);
  }

  private getFallbackReason(lastSynced: number, highest: number): string | null {
    if (highest <= 1) {
      return 'initial version requires full upload';
    }
    if (!lastSynced) {
      return 'no prior sync version recorded';
    }
    if (lastSynced < highest - MAX_VERSION_DRIFT) {
      return `version drift too high (${highest - lastSynced} > ${MAX_VERSION_DRIFT})`;
    }
    if (lastSynced > highest) {
      return `local version behind recorded remote version (${lastSynced} > ${highest})`;
    }
    return null;
  }

  private waitForQueuedUpdates(document: vscode.TextDocument): FilesyncUpdateWithModelVersion[] | null {
    const uri = document.uri;
    const targetVersion = document.version;
    const key = uri.toString();
    const tryGet = (): FilesyncUpdateWithModelVersion[] | null => {
      const lastSynced = this.syncedVersions.get(key) ?? 0;
      const updates = this.updates.getUpdates(uri, lastSynced);
      const latestQueued = this.updates.getLatestVersion(uri) ?? lastSynced;
      if (latestQueued >= targetVersion) {
        return updates;
      }
      return null;
    };
    let attempts = 0;
    let updates = tryGet();
    while (!updates && attempts < CATCHUP_RETRIES) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, CATCHUP_DELAY_MS);
      attempts += 1;
      updates = tryGet();
    }
    if (!updates) {
      this.logger.warn(
        `Failed to gather queued updates for ${vscode.workspace.asRelativePath(uri, false)} after ${attempts} attempt(s); will fallback to latest snapshot if needed`,
      );
    }
    return updates;
  }

  private async syncVisibleEditors(editors: readonly vscode.TextEditor[]): Promise<void> {
    for (const editor of editors) {
      if (this.isTrackableDocument(editor.document)) {
        await this.prepareDocument(editor.document);
      }
    }
  }

  private describeUpdates(entries: FilesyncUpdateWithModelVersion[]): string {
    return entries
      .map((entry) => {
        const changeDetails = entry.updates.map((update, index) => this.describeSingleUpdate(update, index)).join('; ');
        return `[v${entry.modelVersion} expectedLength=${entry.expectedFileLength ?? '?'} changes=${
          entry.updates.length
        } :: ${changeDetails}]`;
      })
      .join(' ');
  }

  private describeSingleUpdate(update: SingleUpdateRequest, index: number): string {
    const start = `${update.range?.startLineNumber ?? '?'}:${update.range?.startColumn ?? '?'}`;
    const end = `${update.range?.endLineNumberInclusive ?? '?'}:${update.range?.endColumn ?? '?'}`;
    const delta = (update.replacedString?.length ?? 0) - (update.changeLength ?? 0);
    const preview = this.truncate(update.replacedString ?? '', 80);
    return `#${index + 1} ${start}-${end} delta=${delta} text="${preview}"`;
  }

  private describeDocument(document: vscode.TextDocument): string {
    const relative = vscode.workspace.asRelativePath(document.uri, false);
    return `${relative}@v${document.version}`;
  }

  private truncate(text: string, maxLength: number): string {
    if (!text) {
      return '';
    }
    const cleaned = text.replace(/\r?\n/g, '\\n');
    if (cleaned.length <= maxLength) {
      return cleaned;
    }
    return `${cleaned.slice(0, maxLength)}...`;
  }
}
