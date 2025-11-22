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
	container.registerSingleton('cursorStateMachine', (c) =>
		new CursorStateMachine(
			c.resolve('tracker'),
			c.resolve('rpcClient'),
			c.resolve('logger'),
			c.resolve('config'),
			c.resolve('fileSync'),
			c.resolve('cursorPrediction')
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

	registerInlineCompletionProvider(stateMachine, context.subscriptions);
	registerInlineAcceptCommand(stateMachine, logger, context.subscriptions);
	registerNextEditCommand(stateMachine, logger, context.subscriptions);

	logger.info('Cometix Tab extension activated');
}

export function deactivate() {}
