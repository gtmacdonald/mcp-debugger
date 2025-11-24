import { EventEmitter } from 'events';
import { DebugProtocol } from '@vscode/debugprotocol';
import {
    IDebugAdapter,
    AdapterState,
    ValidationResult,
    DependencyInfo,
    AdapterCommand,
    AdapterConfig,
    GenericLaunchConfig,
    LanguageSpecificLaunchConfig,
    DebugFeature,
    FeatureRequirement,
    AdapterCapabilities,
    AdapterError,
    AdapterErrorCode,
    AdapterEvents
} from '@debugmcp/shared';
import { DebugLanguage } from '@debugmcp/shared';
import { AdapterDependencies } from '@debugmcp/shared';

export class ZigAdapter extends EventEmitter implements IDebugAdapter {
    readonly language = DebugLanguage.ZIG;
    readonly name = 'Zig Debug Adapter';

    private state: AdapterState = AdapterState.UNINITIALIZED;
    private dependencies: AdapterDependencies;
    private connected = false;
    private currentThreadId: number | null = null;

    constructor(dependencies: AdapterDependencies) {
        super();
        this.dependencies = dependencies;
    }

    async initialize(): Promise<void> {
        this.transitionTo(AdapterState.INITIALIZING);
        try {
            const validation = await this.validateEnvironment();
            if (!validation.valid) {
                this.transitionTo(AdapterState.ERROR);
                throw new AdapterError(
                    validation.errors[0]?.message || 'Zig environment validation failed',
                    AdapterErrorCode.ENVIRONMENT_INVALID
                );
            }
            this.transitionTo(AdapterState.READY);
            this.emit('initialized');
        } catch (error) {
            this.transitionTo(AdapterState.ERROR);
            throw error;
        }
    }

    async dispose(): Promise<void> {
        this.connected = false;
        this.currentThreadId = null;
        this.state = AdapterState.UNINITIALIZED;
        this.emit('disposed');
    }

    getState(): AdapterState {
        return this.state;
    }

    isReady(): boolean {
        return this.state === AdapterState.READY ||
            this.state === AdapterState.CONNECTED ||
            this.state === AdapterState.DEBUGGING;
    }

    getCurrentThreadId(): number | null {
        return this.currentThreadId;
    }

    private transitionTo(newState: AdapterState): void {
        const oldState = this.state;
        this.state = newState;
        this.emit('stateChanged', oldState, newState);
    }

    async validateEnvironment(): Promise<ValidationResult> {
        // In a real implementation, we would check for lldb-dap existence
        // For now, we assume it's there or will be found
        return {
            valid: true,
            errors: [],
            warnings: []
        };
    }

    getRequiredDependencies(): DependencyInfo[] {
        return [
            {
                name: 'lldb-dap',
                version: 'latest',
                required: true,
                installCommand: 'Install LLVM (brew install llvm)'
            }
        ];
    }

    async resolveExecutablePath(preferredPath?: string): Promise<string> {
        return preferredPath || 'lldb-dap';
    }

    getDefaultExecutableName(): string {
        return 'lldb-dap';
    }

    getExecutableSearchPaths(): string[] {
        return ['/usr/bin', '/usr/local/bin', '/opt/homebrew/opt/llvm/bin'];
    }

    buildAdapterCommand(config: AdapterConfig): AdapterCommand {
        return {
            command: config.executablePath,
            args: [
                '--port', config.adapterPort.toString()
            ],
            env: process.env as Record<string, string>
        };
    }

    getAdapterModuleName(): string {
        return 'lldb-dap';
    }

    getAdapterInstallCommand(): string {
        return 'brew install llvm';
    }

    async transformLaunchConfig(config: GenericLaunchConfig): Promise<LanguageSpecificLaunchConfig> {
        return {
            ...config,
            type: 'lldb', // lldb-dap usually expects 'lldb' or just generic launch
            request: 'launch',
            name: 'Zig Launch',
            program: config.args?.[0] || '${workspaceFolder}/zig-out/bin/zig-harness', // Default guess
            cwd: config.cwd || '${workspaceFolder}',
            stopOnEntry: config.stopOnEntry ?? false
        };
    }

    getDefaultLaunchConfig(): Partial<GenericLaunchConfig> {
        return {
            stopOnEntry: false,
            cwd: '${workspaceFolder}'
        };
    }

    async sendDapRequest<T extends DebugProtocol.Response>(
        command: string,
        args?: unknown
    ): Promise<T> {
        // ProxyManager handles this
        return {} as T;
    }

    handleDapEvent(event: DebugProtocol.Event): void {
        if (event.event === 'stopped' && event.body?.threadId) {
            this.currentThreadId = event.body.threadId;
        }
        type AdapterEventName = Extract<keyof AdapterEvents, string | symbol>;
        this.emit(event.event as AdapterEventName, event.body);
    }

    handleDapResponse(_response: DebugProtocol.Response): void {
        // No-op
    }

    async connect(host: string, port: number): Promise<void> {
        this.connected = true;
        this.transitionTo(AdapterState.CONNECTED);
        this.emit('connected');
    }

    async disconnect(): Promise<void> {
        this.connected = false;
        this.currentThreadId = null;
        this.transitionTo(AdapterState.DISCONNECTED);
        this.emit('disconnected');
    }

    isConnected(): boolean {
        return this.connected;
    }

    getInstallationInstructions(): string {
        return 'Install LLVM: brew install llvm. Ensure lldb-dap is in your PATH.';
    }

    getMissingExecutableError(): string {
        return 'lldb-dap not found. Please install LLVM.';
    }

    translateErrorMessage(error: Error): string {
        return error.message;
    }

    supportsFeature(feature: DebugFeature): boolean {
        // lldb-dap supports most standard features
        return true;
    }

    getFeatureRequirements(feature: DebugFeature): FeatureRequirement[] {
        return [];
    }

    getCapabilities(): AdapterCapabilities {
        return {
            supportsConfigurationDoneRequest: true,
            supportsFunctionBreakpoints: true,
            supportsConditionalBreakpoints: true,
            supportsEvaluateForHovers: true,
            supportsSetVariable: true
        };
    }
}
