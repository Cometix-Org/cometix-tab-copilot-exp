import * as vscode from 'vscode';

export type ServiceFactory<T> = (container: ServiceContainer) => T;

/**
 * Extremely small dependency injection container so each module can be
 * unit-tested independently. The container lazily instantiates services
 * and disposes them with the extension context.
 */
export class ServiceContainer {
  private readonly instances = new Map<string, unknown>();
  private readonly factories = new Map<string, ServiceFactory<unknown>>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  registerSingleton<T>(key: string, factory: ServiceFactory<T>): void {
    if (this.factories.has(key)) {
      throw new Error(`Service "${key}" is already registered`);
    }
    this.factories.set(key, factory as ServiceFactory<unknown>);
  }

  resolve<T>(key: string): T {
    if (this.instances.has(key)) {
      return this.instances.get(key) as T;
    }
    const factory = this.factories.get(key);
    if (!factory) {
      throw new Error(`Service "${key}" has not been registered`);
    }
    const instance = factory(this);
    this.instances.set(key, instance);
    if (isDisposable(instance)) {
      this.context.subscriptions.push(instance);
    }
    return instance as T;
  }
}

function isDisposable(value: unknown): value is vscode.Disposable {
  return Boolean(value && typeof (value as vscode.Disposable).dispose === 'function');
}
