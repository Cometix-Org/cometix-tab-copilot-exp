import * as vscode from 'vscode';

/**
 * Model types available for code completion
 */
export type ModelType = 'auto' | 'fast' | 'advanced';

/**
 * Model configuration with labels and descriptions
 */
const MODEL_CONFIG: Record<ModelType, { label: string; description: string; icon: string }> = {
  auto: {
    label: 'Auto',
    description: 'Automatically select the best model based on context',
    icon: '$(sync)',
  },
  fast: {
    label: 'Fast',
    description: 'Fast model for quick completions with lower latency',
    icon: '$(zap)',
  },
  advanced: {
    label: 'Advanced',
    description: 'Advanced model for higher quality completions',
    icon: '$(sparkle)',
  },
};

/**
 * Get the current model from configuration
 */
export function getCurrentModel(): ModelType {
  const config = vscode.workspace.getConfiguration('cometixTab');
  return config.get<ModelType>('model', 'auto');
}

/**
 * Set the model in configuration
 */
export async function setModel(model: ModelType): Promise<void> {
  const config = vscode.workspace.getConfiguration('cometixTab');
  await config.update('model', model, vscode.ConfigurationTarget.Global);
}

/**
 * Get model label for display
 */
export function getModelLabel(model: ModelType): string {
  return MODEL_CONFIG[model]?.label || model;
}

/**
 * Register model-related commands
 */
export function registerModelCommands(context: vscode.ExtensionContext): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  // Command: Select Model
  disposables.push(
    vscode.commands.registerCommand('cometix-tab.selectModel', async () => {
      const currentModel = getCurrentModel();

      const items: vscode.QuickPickItem[] = (Object.keys(MODEL_CONFIG) as ModelType[]).map((model) => {
        const config = MODEL_CONFIG[model];
        const isCurrent = model === currentModel;
        return {
          label: isCurrent ? `${config.icon} ${config.label} $(check)` : `${config.icon} ${config.label}`,
          description: config.description,
          detail: isCurrent ? 'Currently selected' : undefined,
          picked: isCurrent,
        };
      });

      const selected = await vscode.window.showQuickPick(items, {
        title: 'Select Completion Model',
        placeHolder: 'Choose the AI model for code completions',
      });

      if (!selected) {
        return;
      }

      // Extract model from selection
      let newModel: ModelType = 'auto';
      if (selected.label.includes('Fast')) {
        newModel = 'fast';
      } else if (selected.label.includes('Advanced')) {
        newModel = 'advanced';
      } else if (selected.label.includes('Auto')) {
        newModel = 'auto';
      }

      if (newModel !== currentModel) {
        await setModel(newModel);
        vscode.window.showInformationMessage(`Cometix Tab: Model changed to ${getModelLabel(newModel)}`);
      }
    })
  );

  return disposables;
}
