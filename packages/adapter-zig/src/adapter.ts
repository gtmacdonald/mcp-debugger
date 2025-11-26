/**
 * Zig Debug Adapter implementation
 * 
 * Provides Zig-specific debugging functionality using lldb-dap.
 * lldb-dap is the Debug Adapter Protocol implementation for LLDB,
 * which is the native debugger for Zig programs.
 * 
 * @since 2.0.0
 */
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { DebugProtocol } from '@vscode/debugprotocol';
import * as path from 'path';
import * as fs from 'fs';
import {
    IDebugAdapter,
    AdapterState,
    ValidationResult,
    ValidationError,
    ValidationWarning,
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

/**
 * Zig-specific build options
 */
interface ZigBuildOptions {
    autoBuild?: boolean;        // Default: true for .zig files
    binaryName?: string;        // Override auto-detected name
    buildMode?: 'debug' | 'release';  // Default: 'debug'
    projectRoot?: string;       // Override auto-detected root
}

/**
 * Zig-specific launch configuration
 */
interface ZigLaunchConfig extends LanguageSpecificLaunchConfig {
    program: string;              // Path to the Zig executable
    args?: string[];              // Command-line arguments
    cwd?: string;                 // Working directory
    stopOnEntry?: boolean;        // Break at entry point
    initCommands?: string[];      // LLDB commands to run before launch
    preRunCommands?: string[];    // LLDB commands to run after launch but before execution
    postRunCommands?: string[];   // LLDB commands to run after execution starts
    zig?: ZigBuildOptions;        // Zig-specific build options
    [key: string]: unknown;       // Required by LanguageSpecificLaunchConfig
}

/**
 * Zig Debug Adapter implementation
 */
export class ZigAdapter extends EventEmitter implements IDebugAdapter {
    readonly language = DebugLanguage.ZIG;
    readonly name = 'Zig Debug Adapter';

    private state: AdapterState = AdapterState.UNINITIALIZED;
    private dependencies: AdapterDependencies;
    private connected = false;
    private currentThreadId: number | null = null;

    // Cache for lldb-dap path
    private lldbDapPath: string | null = null;

    // Cache for Zig availability
    private zigAvailable: boolean | null = null;

    constructor(dependencies: AdapterDependencies) {
        super();
        this.dependencies = dependencies;
    }

    // ===== Lifecycle Management =====

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
        this.lldbDapPath = null;
        this.zigAvailable = null;
        this.state = AdapterState.UNINITIALIZED;
        this.emit('disposed');
    }

    // ===== State Management =====

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

    // ===== Environment Validation =====

    async validateEnvironment(): Promise<ValidationResult> {
        const errors: ValidationError[] = [];
        const warnings: ValidationWarning[] = [];

        try {
            // Check for lldb-dap executable
            const lldbDapPath = await this.findLldbDap();

            if (!lldbDapPath) {
                errors.push({
                    code: 'LLDB_DAP_NOT_FOUND',
                    message: 'lldb-dap not found. Please install LLVM (brew install llvm)',
                    recoverable: false
                });
            } else {
                this.lldbDapPath = lldbDapPath;
                this.dependencies.logger?.info(`[ZigAdapter] Found lldb-dap at: ${lldbDapPath}`);

                // Check lldb-dap version
                const version = await this.checkLldbDapVersion(lldbDapPath);
                if (version) {
                    this.dependencies.logger?.info(`[ZigAdapter] lldb-dap version: ${version}`);
                } else {
                    warnings.push({
                        code: 'LLDB_DAP_VERSION_CHECK_FAILED',
                        message: 'Could not determine lldb-dap version'
                    });
                }
            }

            // Check for Zig installation (required for auto-build of .zig files)
            const { checkZigInstallation, getZigVersion, checkZigMinVersion } = await import('./utils/zig-utils.js');

            const zigInstalled = await checkZigInstallation();
            if (!zigInstalled) {
                // Zig not being installed is a warning, not an error
                // Users can still debug pre-built binaries
                this.zigAvailable = false;
                warnings.push({
                    code: 'ZIG_NOT_FOUND',
                    message: 'Zig not found in PATH. Auto-build will not be available. Install from https://ziglang.org/download/'
                });
            } else {
                this.zigAvailable = true;

                // Check Zig version
                const zigVersion = await getZigVersion();
                if (zigVersion) {
                    this.dependencies.logger?.info(`[ZigAdapter] Found Zig version: ${zigVersion}`);

                    // Check minimum version (0.11.0+)
                    const meetsMinVersion = await checkZigMinVersion('0.11.0');
                    if (!meetsMinVersion) {
                        warnings.push({
                            code: 'ZIG_VERSION_LOW',
                            message: `Zig version ${zigVersion} may have compatibility issues. Recommend 0.11.0+`
                        });
                    }
                }
            }
        } catch (error) {
            errors.push({
                code: 'LLDB_DAP_VALIDATION_ERROR',
                message: error instanceof Error ? error.message : 'lldb-dap validation failed',
                recoverable: false
            });
        }

        return {
            valid: errors.length === 0,
            errors,
            warnings
        };
    }

    getRequiredDependencies(): DependencyInfo[] {
        return [
            {
                name: 'lldb-dap',
                version: 'latest',
                required: true,
                installCommand: 'brew install llvm'
            },
            {
                name: 'Zig',
                version: '0.11+',
                required: true,
                installCommand: 'brew install zig'
            }
        ];
    }

    // ===== Executable Management =====

    async resolveExecutablePath(preferredPath?: string): Promise<string> {
        if (preferredPath) {
            // Verify the preferred path exists
            if (fs.existsSync(preferredPath)) {
                return preferredPath;
            }
            this.dependencies.logger?.warn(`[ZigAdapter] Preferred path ${preferredPath} not found`);
        }

        // Use cached path if available
        if (this.lldbDapPath) {
            return this.lldbDapPath;
        }

        // Find lldb-dap
        const lldbDapPath = await this.findLldbDap();
        if (!lldbDapPath) {
            throw new AdapterError(
                'lldb-dap not found. Please install LLVM.',
                AdapterErrorCode.EXECUTABLE_NOT_FOUND
            );
        }

        this.lldbDapPath = lldbDapPath;
        return lldbDapPath;
    }

    getDefaultExecutableName(): string {
        return 'lldb-dap';
    }

    getExecutableSearchPaths(): string[] {
        const paths: string[] = [];

        // Add common LLVM installation paths
        if (process.platform === 'darwin') {
            // macOS paths
            paths.push(
                '/opt/homebrew/opt/llvm/bin',      // Homebrew on Apple Silicon
                '/usr/local/opt/llvm/bin',          // Homebrew on Intel
                '/opt/homebrew/bin',
                '/usr/local/bin',
                '/usr/bin'
            );
        } else if (process.platform === 'linux') {
            paths.push(
                '/usr/bin',
                '/usr/local/bin',
                '/opt/llvm/bin'
            );
        } else if (process.platform === 'win32') {
            paths.push(
                'C:\\\\Program Files\\\\LLVM\\\\bin',
                'C:\\\\LLVM\\\\bin'
            );
        }

        // Add PATH directories
        if (process.env.PATH) {
            paths.push(...process.env.PATH.split(path.delimiter));
        }

        return paths;
    }

    // ===== Adapter Configuration =====

    buildAdapterCommand(config: AdapterConfig): AdapterCommand {
        // lldb-dap needs --connection flag to listen for TCP connections
        // Format: --connection listen://host:port

        // Filter out undefined values from process.env
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
            if (value !== undefined) {
                env[key] = value;
            }
        }

        return {
            command: config.executablePath,
            args: [
                '--connection',
                `listen://${config.adapterHost}:${config.adapterPort}`
            ],
            env
        };
    }

    getAdapterModuleName(): string {
        return 'lldb-dap';
    }

    getAdapterInstallCommand(): string {
        return 'brew install llvm';
    }

    // ===== Debug Configuration =====

    async transformLaunchConfig(config: GenericLaunchConfig): Promise<LanguageSpecificLaunchConfig> {
        // Extract program path from args
        const program = config.args?.[0];

        if (!program) {
            throw new AdapterError(
                'No program specified. Please provide the path to your Zig executable or source file in args.',
                AdapterErrorCode.SCRIPT_NOT_FOUND
            );
        }

        // Get Zig-specific options
        const zigOptions = (config as ZigLaunchConfig).zig || {};
        const autoBuild = zigOptions.autoBuild !== false; // Default to true

        let resolvedProgram = program;

        // Handle .zig source files with auto-build
        if (program.endsWith('.zig') && autoBuild) {
            this.dependencies.logger?.info('[ZigAdapter] Detected .zig source file, checking for auto-build...');

            // Check if Zig is available
            if (this.zigAvailable === false) {
                throw new AdapterError(
                    'Zig is not installed. Cannot auto-build from .zig source file. ' +
                    'Either install Zig (https://ziglang.org/download/) or provide a pre-built binary.',
                    AdapterErrorCode.ENVIRONMENT_INVALID
                );
            }

            try {
                // Import build utilities
                const {
                    findZigProjectRoot,
                    getDefaultBinary,
                    needsRebuild,
                    buildZigProject,
                    getZigBinaryPath
                } = await import('./utils/zig-build-utils.js');

                // Find project root
                const projectRoot = zigOptions.projectRoot || await findZigProjectRoot(program);
                this.dependencies.logger?.info(`[ZigAdapter] Found Zig project at: ${projectRoot}`);

                // Determine binary name
                const binaryName = zigOptions.binaryName || await getDefaultBinary(projectRoot);
                const binaryPath = getZigBinaryPath(projectRoot, binaryName);

                // Check if build is needed
                const buildMode = zigOptions.buildMode || 'debug';
                const rebuildNeeded = await needsRebuild(projectRoot, binaryName);

                if (rebuildNeeded) {
                    this.dependencies.logger?.info(`[ZigAdapter] Binary is out of date, building in ${buildMode} mode...`);

                    const buildResult = await buildZigProject(
                        projectRoot,
                        this.dependencies.logger,
                        buildMode
                    );

                    if (!buildResult.success) {
                        throw new AdapterError(
                            `Zig build failed: ${buildResult.error}`,
                            AdapterErrorCode.DEBUGGER_ERROR
                        );
                    }

                    resolvedProgram = buildResult.binaryPath!;
                    this.dependencies.logger?.info(`[ZigAdapter] Build successful: ${resolvedProgram}`);
                } else {
                    this.dependencies.logger?.info('[ZigAdapter] Binary is up to date, skipping build');
                    resolvedProgram = binaryPath;
                }
            } catch (error) {
                // Re-throw AdapterErrors
                if (error instanceof AdapterError) {
                    throw error;
                }

                // Handle project root not found
                if (error instanceof Error && error.message.includes('build.zig')) {
                    throw new AdapterError(
                        `No build.zig found for ${program}. Create a build.zig or provide a pre-built binary.`,
                        AdapterErrorCode.SCRIPT_NOT_FOUND
                    );
                }

                throw new AdapterError(
                    `Failed to auto-build Zig project: ${error instanceof Error ? error.message : String(error)}`,
                    AdapterErrorCode.DEBUGGER_ERROR
                );
            }
        }

        // Verify the program exists
        if (!fs.existsSync(resolvedProgram)) {
            throw new AdapterError(
                `Program not found: ${resolvedProgram}. Make sure to build with debug symbols (zig build).`,
                AdapterErrorCode.SCRIPT_NOT_FOUND
            );
        }

        const zigConfig: ZigLaunchConfig = {
            ...config,
            type: 'lldb',
            request: 'launch',
            name: 'Zig Debug',
            program: resolvedProgram,
            args: config.args?.slice(1) || [],  // Remove program from args if present
            cwd: config.cwd || path.dirname(resolvedProgram),
            stopOnEntry: config.stopOnEntry ?? false,
            // LLDB-specific commands
            initCommands: [
                // Set up Zig-friendly debugging
                'settings set target.process.follow-fork-mode child',
            ],
            preRunCommands: [],
            postRunCommands: [],
            zig: zigOptions
        };

        return zigConfig;
    }

    getDefaultLaunchConfig(): Partial<GenericLaunchConfig> {
        return {
            stopOnEntry: false,
            cwd: '${workspaceFolder}',
            args: ['${workspaceFolder}/zig-out/bin/zig-harness']
        };
    }

    // ===== DAP Protocol Operations =====

    async sendDapRequest<T extends DebugProtocol.Response>(
        command: string,
        args?: unknown
    ): Promise<T> {
        // ProxyManager handles the actual DAP communication
        // This method is just for validation

        // Validate Zig-specific commands if needed
        this.dependencies.logger?.debug(`[ZigAdapter] DAP request: ${command}`, args);

        return {} as T;
    }

    handleDapEvent(event: DebugProtocol.Event): void {
        // Update thread ID on stopped events
        if (event.event === 'stopped' && event.body?.threadId) {
            this.currentThreadId = event.body.threadId;
            this.dependencies.logger?.debug(`[ZigAdapter] Stopped on thread ${event.body.threadId}`);
        }

        // Forward event to listeners
        type AdapterEventName = Extract<keyof AdapterEvents, string | symbol>;
        this.emit(event.event as AdapterEventName, event.body);
    }

    handleDapResponse(_response: DebugProtocol.Response): void {
        // Zig adapter doesn't need special response handling
        void _response;
    }

    // ===== Connection Management =====

    async connect(host: string, port: number): Promise<void> {
        this.dependencies.logger?.debug(`[ZigAdapter] Connect request to ${host}:${port}`);
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

    // ===== Error Handling =====

    getInstallationInstructions(): string {
        return `Zig Debugging Setup:

1. Install LLVM (includes lldb-dap):
   - macOS: brew install llvm
   - Linux: sudo apt install llvm
   - Windows: Download from https://releases.llvm.org/

2. Install Zig:
   - macOS: brew install zig
   - Linux: snap install zig --classic
   - Windows: Download from https://ziglang.org/download/

3. Build your Zig program with debug symbols:
   zig build

4. Verify lldb-dap is available:
   lldb-dap --version`;
    }

    getMissingExecutableError(): string {
        return `lldb-dap not found. Please ensure LLVM is installed and lldb-dap is in your PATH.

macOS users: brew install llvm
Linux users: sudo apt install llvm
Windows users: Download from https://releases.llvm.org/

After installation, you may need to add LLVM's bin directory to your PATH.`;
    }

    translateErrorMessage(error: Error): string {
        const message = error.message.toLowerCase();

        if (message.includes('lldb-dap') && message.includes('not found')) {
            return this.getMissingExecutableError();
        }

        if (message.includes('permission denied')) {
            return 'Permission denied accessing lldb-dap. Check file permissions.';
        }

        if (message.includes('program not found')) {
            return 'Zig executable not found. Make sure to build your program with: zig build';
        }

        return error.message;
    }

    // ===== Feature Support =====

    supportsFeature(feature: DebugFeature): boolean {
        // lldb-dap supports most standard debugging features
        const supportedFeatures = [
            DebugFeature.CONDITIONAL_BREAKPOINTS,
            DebugFeature.FUNCTION_BREAKPOINTS,
            DebugFeature.EXCEPTION_BREAKPOINTS,
            DebugFeature.EVALUATE_FOR_HOVERS,
            DebugFeature.SET_VARIABLE,
            DebugFeature.TERMINATE_REQUEST
        ];

        return supportedFeatures.includes(feature);
    }

    getFeatureRequirements(feature: DebugFeature): FeatureRequirement[] {
        const requirements: FeatureRequirement[] = [];

        switch (feature) {
            case DebugFeature.CONDITIONAL_BREAKPOINTS:
                requirements.push({
                    type: 'dependency',
                    description: 'LLVM 10+',
                    required: true
                });
                break;
        }

        return requirements;
    }

    getCapabilities(): AdapterCapabilities {
        return {
            supportsConfigurationDoneRequest: true,
            supportsFunctionBreakpoints: true,
            supportsConditionalBreakpoints: true,
            supportsHitConditionalBreakpoints: true,
            supportsEvaluateForHovers: true,
            supportsSetVariable: true,
            supportsStepBack: false,
            supportsRestartFrame: false,
            supportsGotoTargetsRequest: false,
            supportsStepInTargetsRequest: false,
            supportsCompletionsRequest: true,
            supportsModulesRequest: false,
            supportsRestartRequest: false,
            supportsExceptionOptions: false,
            supportsValueFormattingOptions: true,
            supportsExceptionInfoRequest: false,
            supportTerminateDebuggee: true,
            supportSuspendDebuggee: false,
            supportsDelayedStackTraceLoading: false,
            supportsLoadedSourcesRequest: false,
            supportsLogPoints: false,
            supportsTerminateThreadsRequest: false,
            supportsSetExpression: false,
            supportsTerminateRequest: true,
            supportsDataBreakpoints: false,
            supportsReadMemoryRequest: true,
            supportsWriteMemoryRequest: false,
            supportsDisassembleRequest: true,
            supportsCancelRequest: false,
            supportsBreakpointLocationsRequest: false,
            supportsClipboardContext: false,
            supportsSteppingGranularity: false,
            supportsInstructionBreakpoints: false,
            supportsExceptionFilterOptions: false,
            supportsSingleThreadExecutionRequests: false
        };
    }

    // ===== Zig-specific helper methods =====

    /**
     * Find lldb-dap executable in common locations
     */
    private async findLldbDap(): Promise<string | null> {
        const searchPaths = this.getExecutableSearchPaths();
        const executableName = this.getDefaultExecutableName();

        for (const searchPath of searchPaths) {
            const fullPath = path.join(searchPath, executableName);
            if (fs.existsSync(fullPath)) {
                try {
                    // Verify it's executable
                    fs.accessSync(fullPath, fs.constants.X_OK);
                    return fullPath;
                } catch {
                    // Not executable, continue searching
                    continue;
                }
            }
        }

        return null;
    }

    /**
     * Check lldb-dap version
     */
    private async checkLldbDapVersion(lldbDapPath: string): Promise<string | null> {
        return new Promise((resolve) => {
            try {
                const child = spawn(lldbDapPath, ['--version'], {
                    stdio: ['ignore', 'pipe', 'pipe']
                });

                if (!child) {
                    resolve(null);
                    return;
                }

                let output = '';
                child.stdout?.on('data', (data) => { output += data.toString(); });
                child.stderr?.on('data', (data) => { output += data.toString(); });

                child.on('error', () => resolve(null));
                child.on('exit', (code) => {
                    if (code === 0 && output.trim().length > 0) {
                        // Extract version from output
                        const versionMatch = output.match(/version\s+(\d+\.\d+\.\d+)/i);
                        resolve(versionMatch ? versionMatch[1] : output.trim());
                    } else {
                        resolve(null);
                    }
                });
            } catch {
                resolve(null);
            }
        });
    }
}
