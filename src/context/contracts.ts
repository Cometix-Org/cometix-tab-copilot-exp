import * as vscode from 'vscode';
import {
  FilesyncUpdateWithModelVersion,
  FSUploadFileRequest,
  FSUploadFileResponse,
  FSSyncFileRequest,
  FSSyncFileResponse,
  RefreshTabContextRequest,
  RefreshTabContextResponse,
  StreamCppRequest,
  StreamCppResponse,
  StreamNextCursorPredictionRequest,
  StreamNextCursorPredictionResponse,
} from '../rpc/cursor-tab_pb';
import { CursorFeatureFlags } from './types';

export interface ILogger extends vscode.Disposable {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, err?: unknown): void;
}

export interface IConfigService extends vscode.Disposable {
  readonly flags: CursorFeatureFlags;
  readonly onDidChange: vscode.Event<CursorFeatureFlags>;
}

export interface IDocumentTracker extends vscode.Disposable {
  getHistory(uri: vscode.Uri): string[];
  clear(uri: vscode.Uri): void;
}

export interface IRpcClient extends vscode.Disposable {
  streamCpp(request: StreamCppRequest, abortController?: AbortController): Promise<AsyncIterable<StreamCppResponse>>;
  streamNextCursorPrediction(
    request: StreamNextCursorPredictionRequest,
    abortController?: AbortController
  ): Promise<AsyncIterable<StreamNextCursorPredictionResponse>>;
  refreshTabContext(request: RefreshTabContextRequest): Promise<RefreshTabContextResponse>;
  uploadFile(request: FSUploadFileRequest): Promise<FSUploadFileResponse>;
  syncFile(request: FSSyncFileRequest): Promise<FSSyncFileResponse>;
}

export interface IFileSyncCoordinator extends vscode.Disposable {
  prepareDocument(document: vscode.TextDocument): Promise<void>;
  getSyncPayload(document: vscode.TextDocument): { relyOnFileSync: boolean; updates: FilesyncUpdateWithModelVersion[] };
  shouldRelyOnFileSync(document: vscode.TextDocument): boolean;
}

export interface ICursorPredictionController extends vscode.Disposable {
  handleSuggestionAccepted(editor: vscode.TextEditor): Promise<void>;
  clearForDocument(document: vscode.TextDocument): void;
}
