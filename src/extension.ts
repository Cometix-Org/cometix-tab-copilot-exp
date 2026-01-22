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
import { registerEndpointCommands } from './commands/endpointCommands';
import { registerModelCommands } from './commands/modelCommands';
// New services for enhanced functionality
import { DebounceManager } from './services/debounceManager';
import { RecentFilesTracker } from './services/recentFilesTracker';
import { TelemetryService } from './services/telemetryService';
import { LspSuggestionsTracker } from './services/lspSuggestionsTracker';
import { WorkspaceStorage } from './services/workspaceStorage';
import { DiagnosticsTracker } from './services/diagnosticsTracker';
import { EndpointManager } from './services/endpointManager';
import { TriggerSource } from './context/types';
// UI components
import { StatusBar } from './ui/statusBar';
import { StatusBarPicker } from './ui/statusBarPicker';
import { showSnoozePicker } from './ui/menuPanel';
import { SnoozeService } from './services/snoozeService';
import { ServerConfigService } from './services/serverConfigService';
import { ensureProposedApiEnabled, resetIgnoreProposalCheck, checkAndPromptProposedApiOnStartup } from './services/productJsonPatcher';

export async function activate(context: vscode.ExtensionContext) {
	// ========== 最优先：检查 Proposed API 是否可用 ==========
	// 必须在任何使用 proposed API 的代码之前执行
	const extensionId = 'Haleclipse.cometix-tab';
	const requiredProposals = ['inlineCompletionsAdditions'];
	
	const canActivate = await ensureProposedApiEnabled(context, extensionId, requiredProposals);
	if (!canActivate) {
		// 用户选择稍后提醒或修改 product.json 后会重启，停止激活
		return;
	}
	// ========== Proposed API 检查完成 ==========
	const container = new ServiceContainer(context);

	container.registerSingleton('logger', () => new Logger());
	container.registerSingleton('tracker', () => new DocumentTracker());
	container.registerSingleton('endpointManager', () => new EndpointManager(context));
	container.registerSingleton('rpcClient', (c) => new RpcClient(c.resolve('logger'), c.resolve('endpointManager')));
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
	container.registerSingleton('diagnosticsTracker', (c) => new DiagnosticsTracker(c.resolve('logger')));
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
	const diagnosticsTracker = container.resolve<DiagnosticsTracker>('diagnosticsTracker');
	const lspSuggestionsTracker = container.resolve<LspSuggestionsTracker>('lspSuggestionsTracker');

	// Wire trigger sources to the completion provider
	const inlineEditTriggerer = stateMachine.getInlineEditTriggerer();

	// LinterErrors: trigger when new errors appear
	diagnosticsTracker.onNewErrors(({ document, position }) => {
		logger.info('[Extension] Triggering completion due to new linter errors');
		inlineEditTriggerer.manualTrigger(document, position, TriggerSource.LinterErrors);
	});

	// ParameterHints: trigger when signature help appears/changes
	lspSuggestionsTracker.onParameterHintsChange(({ document, position }) => {
		logger.info('[Extension] Triggering completion due to parameter hints');
		inlineEditTriggerer.manualTrigger(document, position, TriggerSource.ParameterHints);
	});

	// LspSuggestions: trigger when LSP completions are detected
	lspSuggestionsTracker.onCompletionsAvailable(({ document, position }) => {
		logger.info('[Extension] Triggering completion due to LSP suggestions');
		inlineEditTriggerer.manualTrigger(document, position, TriggerSource.LspSuggestions);
	});

	registerInlineCompletionProvider(stateMachine, logger, context.subscriptions);
	registerInlineAcceptCommand(stateMachine, logger, context.subscriptions);
	registerNextEditCommand(stateMachine, logger, context.subscriptions);
	registerCursorPredictionCommand(logger, context.subscriptions);

	const endpointManager = container.resolve<EndpointManager>('endpointManager');
	const rpcClient = container.resolve<RpcClient>('rpcClient');
	
	// Register endpoint commands
	const endpointCommandDisposables = registerEndpointCommands(
		context,
		endpointManager,
		() => rpcClient.refreshClient()
	);
	context.subscriptions.push(...endpointCommandDisposables);

	// Register model commands
	const modelCommandDisposables = registerModelCommands(context);
	context.subscriptions.push(...modelCommandDisposables);

	// Initialize UI components
	const snoozeService = SnoozeService.getInstance();
	const serverConfigService = ServerConfigService.getInstance();
	const statusBar = new StatusBar();
	const statusBarPicker = new StatusBarPicker();

	// Get telemetry service from container for UI integration
	const telemetryService = container.resolve<TelemetryService>('telemetryService');
	const debounceManager = container.resolve<DebounceManager>('debounceManager');

	// Wire up StatusBar with services
	statusBar.setTelemetryService(telemetryService);
	statusBar.setEndpointManager(endpointManager);

	// Wire up StatusBarPicker with services
	statusBarPicker.setTelemetryService(telemetryService);
	statusBarPicker.setEndpointManager(endpointManager);

	context.subscriptions.push(snoozeService);
	context.subscriptions.push(serverConfigService);
	context.subscriptions.push(statusBar);
	context.subscriptions.push(statusBarPicker);

	// Register new commands
	context.subscriptions.push(
		vscode.commands.registerCommand('cometix-tab.toggleEnabled', async () => {
			const config = vscode.workspace.getConfiguration('cometixTab');
			const currentEnabled = config.get<boolean>('enabled', true);
			await config.update('enabled', !currentEnabled, vscode.ConfigurationTarget.Global);
			vscode.window.showInformationMessage(
				`Cometix Tab: ${!currentEnabled ? 'Enabled' : 'Disabled'}`
			);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('cometix-tab.showStatusMenu', () => {
			statusBarPicker.show();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('cometix-tab.resetStatistics', () => {
			telemetryService.resetStatistics();
			vscode.window.showInformationMessage('Cometix Tab: Statistics reset');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('cometix-tab.showLogs', () => {
			logger.show();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('cometix-tab.manualTriggerCompletion', () => {
			const editor = vscode.window.activeTextEditor;
			if (editor) {
				const config = vscode.workspace.getConfiguration('cometixTab');
				if (!config.get<boolean>('enabled', true)) {
					vscode.window.showWarningMessage('Cometix Tab is disabled');
					return;
				}
				if (snoozeService.isSnoozing()) {
					vscode.window.showWarningMessage(`Cometix Tab is snoozed for ${snoozeService.getRemainingMinutes()} more minutes`);
					return;
				}
				inlineEditTriggerer.manualTrigger(editor.document, editor.selection.active, TriggerSource.ManualTrigger);
				logger.info('[Extension] Manual completion triggered via Alt+\\');
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('cometix-tab.showSnoozePicker', () => {
			showSnoozePicker();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('cometix-tab.cancelSnooze', () => {
			snoozeService.cancelSnooze();
			vscode.window.showInformationMessage('Cometix Tab: Snooze cancelled');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('cometix-tab.showServerConfig', () => {
			serverConfigService.showConfig();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('cometix-tab.enableProposedApi', async () => {
			// Reset ignore state and trigger check
			await resetIgnoreProposalCheck(context);
			const extId = 'Haleclipse.cometix-tab';
			const proposals = ['inlineCompletionsAdditions'];
			await checkAndPromptProposedApiOnStartup(context, extId, proposals, logger);
		})
	);

	// Fetch server config on activation
	fetchAndCacheServerConfig(rpcClient, serverConfigService, logger);
	// Apply debounce durations when server config updates
	serverConfigService.onConfigUpdated((cfg) => {
		const clientMs = cfg.clientDebounceMs;
		const globalMs = cfg.globalDebounceMs;
		if (clientMs !== undefined || globalMs !== undefined) {
			debounceManager.setDebounceDurations({
				clientDebounceDuration: clientMs,
				totalDebounceDuration: globalMs,
			});
			logger.info(`[Extension] Updated debounce durations from server config (client=${clientMs ?? '-'}ms, global=${globalMs ?? '-'}ms)`);
		}
	});

	// Note: Proposed API check already done at the start of activate()

	logger.info('Cometix Tab extension activated');
}

/**
 * Fetch CppConfig from server and cache it
 */
async function fetchAndCacheServerConfig(
	rpcClient: RpcClient,
	serverConfigService: ServerConfigService,
	logger: Logger
): Promise<void> {
	try {
		const response = await rpcClient.getCppConfig();
		serverConfigService.updateFromResponse(response);
		logger.info('[Extension] Server config fetched and cached');
	} catch (err) {
		logger.warn(`[Extension] Failed to fetch server config: ${err}`);
	}
}

export function deactivate() {}
