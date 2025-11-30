import * as vscode from 'vscode';
import { ServiceContainer } from './container/serviceContainer';
import { Logger } from './services/logger';
import { DocumentTracker } from './services/documentTracker';
import { RpcClient } from './services/rpcClient';
import { CursorStateMachine } from './services/cursorStateMachine';
import { ConfigService } from './services/configService';
import { FileSyncCoordinator } from './services/fileSyncCoordinator';
import { registerInlineCompletionProvider } from './providers/inlineCompletionProvider';
import { registerInlineAcceptCommand } from './commands/inlineAcceptCommand';
import { CursorPredictionController } from './controllers/cursorPredictionController';
import { FilesyncUpdatesStore } from './services/filesyncUpdatesStore';
import { registerNextEditCommand } from './commands/nextEditCommand';
import { registerCursorPredictionCommand } from './commands/cursorPredictionCommand';
// New services for enhanced functionality
import { DebounceManager } from './services/debounceManager';
import { RecentFilesTracker } from './services/recentFilesTracker';
import { TelemetryService } from './services/telemetryService';
import { LspSuggestionsTracker } from './services/lspSuggestionsTracker';
import { WorkspaceStorage } from './services/workspaceStorage';

export function activate(context: vscode.ExtensionContext) {
	const container = new ServiceContainer(context);

	container.registerSingleton('logger', () => new Logger());
	container.registerSingleton('tracker', () => new DocumentTracker());
	container.registerSingleton('rpcClient', (c) => new RpcClient(c.resolve('logger')));
	container.registerSingleton('config', () => new ConfigService());
	container.registerSingleton('fileSyncUpdates', (c) => new FilesyncUpdatesStore(c.resolve('logger')));
	container.registerSingleton('fileSync', (c) => new FileSyncCoordinator(
		c.resolve('rpcClient'),
		c.resolve('logger'),
		c.resolve('fileSyncUpdates')
	));
	
	// New services for cursor-style functionality
	container.registerSingleton('debounceManager', (c) => new DebounceManager(c.resolve('logger')));
	container.registerSingleton('recentFilesTracker', (c) => new RecentFilesTracker(c.resolve('logger')));
	container.registerSingleton('telemetryService', (c) => new TelemetryService(c.resolve('logger')));
	container.registerSingleton('lspSuggestionsTracker', (c) => new LspSuggestionsTracker(c.resolve('logger')));
	// Workspace storage for persisting workspaceId and controlToken
	container.registerSingleton('workspaceStorage', () => new WorkspaceStorage(context));
	
	container.registerSingleton('cursorStateMachine', (c) =>
		new CursorStateMachine(
			c.resolve('tracker'),
			c.resolve('rpcClient'),
			c.resolve('logger'),
			c.resolve('config'),
			c.resolve('fileSync'),
			c.resolve('cursorPrediction'),
			// New service dependencies
			c.resolve('debounceManager'),
			c.resolve('recentFilesTracker'),
			c.resolve('telemetryService'),
			c.resolve('lspSuggestionsTracker'),
			// Workspace storage for persistent data
			c.resolve('workspaceStorage')
		)
	);
	container.registerSingleton('cursorPrediction', (c) =>
		new CursorPredictionController(
			c.resolve('tracker'),
			c.resolve('rpcClient'),
			c.resolve('config'),
			c.resolve('logger'),
			c.resolve('fileSync')
		)
	);

	const logger = container.resolve<Logger>('logger');
	const stateMachine = container.resolve<CursorStateMachine>('cursorStateMachine');
	container.resolve<CursorPredictionController>('cursorPrediction');

	registerInlineCompletionProvider(stateMachine, logger, context.subscriptions);
	registerInlineAcceptCommand(stateMachine, logger, context.subscriptions);
	registerNextEditCommand(stateMachine, logger, context.subscriptions);
	registerCursorPredictionCommand(logger, context.subscriptions);

	logger.info('Cometix Tab extension activated');
}

export function deactivate() {}
