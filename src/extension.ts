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
	container.registerSingleton('fileSyncUpdates', () => new FilesyncUpdatesStore());
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
			c.resolve('fileSync')
		)
	);

	const logger = container.resolve<Logger>('logger');
	const stateMachine = container.resolve<CursorStateMachine>('cursorStateMachine');
	const tracker = container.resolve<DocumentTracker>('tracker');
	const rpcClient = container.resolve<RpcClient>('rpcClient');
	const config = container.resolve<ConfigService>('config');

	registerInlineCompletionProvider(stateMachine, context.subscriptions);
	registerInlineAcceptCommand(stateMachine, logger, context.subscriptions);
	registerNextEditCommand(stateMachine, logger, context.subscriptions);

	const predictionController = new CursorPredictionController(tracker, rpcClient, config, logger);
	context.subscriptions.push(predictionController);

	logger.info('Cometix Tab extension activated');
}

export function deactivate() {}
