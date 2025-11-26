import { describe, it, expect, afterEach, vi, type Mock } from 'vitest';
import { EventEmitter } from 'events';
import { ZigAdapter } from '../../../packages/adapter-zig/src/adapter.js';
import { AdapterState, AdapterError, DebugFeature } from '@debugmcp/shared';

vi.mock('child_process', () => ({
    spawn: vi.fn(),
    exec: vi.fn()
}));

vi.mock('fs', () => ({
    existsSync: vi.fn(),
    accessSync: vi.fn(),
    constants: { X_OK: 1, F_OK: 0, R_OK: 4 }
}));

vi.mock('fs/promises', () => ({
    stat: vi.fn(),
    access: vi.fn(),
    readFile: vi.fn(),
    readdir: vi.fn(),
    mkdtemp: vi.fn(),
    writeFile: vi.fn(),
    rm: vi.fn(),
    mkdir: vi.fn()
}));

const { spawn } = await import('child_process');
const fs = await import('fs');
const fsp = await import('fs/promises');

/**
 * Create a mock child process with stdout/stderr emitters
 */
const createMockChild = () => {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    return child;
};

/**
 * Setup spawn mock to handle both lldb-dap and zig version checks
 */
const setupSpawnForValidation = () => {
    const spawnMock = spawn as unknown as Mock;
    const lldbChild = createMockChild();
    const zigChild = createMockChild();
    let callCount = 0;

    spawnMock.mockImplementation((cmd: string, args: string[]) => {
        // Return appropriate mock based on command
        if (cmd === 'zig') {
            // Emit zig version response
            setImmediate(() => {
                zigChild.stdout.emit('data', '0.13.0\n');
                zigChild.emit('exit', 0);
            });
            return zigChild;
        } else {
            // lldb-dap version check (or any other spawn)
            setImmediate(() => {
                lldbChild.stdout.emit('data', 'lldb version 15.0.0');
                lldbChild.emit('exit', 0);
            });
            return lldbChild;
        }
    });

    return spawnMock;
};

const createDependencies = () => ({
    fileSystem: {} as unknown,
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
    },
    environment: {} as unknown,
    processLauncher: {} as unknown,
    networkManager: undefined
});

describe('ZigAdapter', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('validates environment and finds lldb-dap', async () => {
        const adapter = new ZigAdapter(createDependencies());
        const existsSyncMock = fs.existsSync as unknown as Mock;
        const accessSyncMock = fs.accessSync as unknown as Mock;

        // Mock finding lldb-dap
        existsSyncMock.mockReturnValue(true);
        accessSyncMock.mockReturnValue(undefined);
        setupSpawnForValidation();

        const result = await adapter.validateEnvironment();

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
    });

    it('reports error when lldb-dap is not found', async () => {
        const adapter = new ZigAdapter(createDependencies());
        const existsSyncMock = fs.existsSync as unknown as Mock;

        existsSyncMock.mockReturnValue(false);
        // Setup spawn for zig version check (Zig is still checked even if lldb-dap fails)
        setupSpawnForValidation();

        const result = await adapter.validateEnvironment();

        expect(result.valid).toBe(false);
        expect(result.errors[0]?.code).toBe('LLDB_DAP_NOT_FOUND');
    });

    it('checks lldb-dap version', async () => {
        const adapter = new ZigAdapter(createDependencies());
        const existsSyncMock = fs.existsSync as unknown as Mock;
        const accessSyncMock = fs.accessSync as unknown as Mock;

        existsSyncMock.mockReturnValue(true);
        accessSyncMock.mockReturnValue(undefined);
        setupSpawnForValidation();

        const result = await adapter.validateEnvironment();

        expect(result.valid).toBe(true);
    });

    it('builds adapter command with TCP listen connection', () => {
        const adapter = new ZigAdapter(createDependencies());
        const cmd = adapter.buildAdapterCommand({
            sessionId: 's1',
            executablePath: '/opt/homebrew/opt/llvm/bin/lldb-dap',
            adapterHost: '127.0.0.1',
            adapterPort: 9000,
            logDir: '/tmp/logs',
            scriptPath: '/app/main',
            launchConfig: {}
        });

        expect(cmd.command).toBe('/opt/homebrew/opt/llvm/bin/lldb-dap');
        expect(cmd.args).toEqual(['--connection', 'listen://127.0.0.1:9000']);
        expect(cmd.env).toBeDefined();
    });

    it('transforms launch config with Zig-specific settings', async () => {
        const adapter = new ZigAdapter(createDependencies());
        const existsSyncMock = fs.existsSync as unknown as Mock;

        existsSyncMock.mockReturnValue(true);

        const config = await adapter.transformLaunchConfig({
            args: ['/path/to/zig-harness', 'arg1', 'arg2'],
            stopOnEntry: true
        });

        expect(config.type).toBe('lldb');
        expect(config.request).toBe('launch');
        expect(config.program).toBe('/path/to/zig-harness');
        expect(config.args).toEqual(['arg1', 'arg2']);
        expect(config.stopOnEntry).toBe(true);
        expect(config.initCommands).toBeDefined();
    });

    it('throws error when program is not specified', async () => {
        const adapter = new ZigAdapter(createDependencies());

        await expect(
            adapter.transformLaunchConfig({})
        ).rejects.toThrow('No program specified');
    });

    it('throws error when program file does not exist', async () => {
        const adapter = new ZigAdapter(createDependencies());
        const existsSyncMock = fs.existsSync as unknown as Mock;

        existsSyncMock.mockReturnValue(false);

        await expect(
            adapter.transformLaunchConfig({
                args: ['/nonexistent/program']
            })
        ).rejects.toThrow('Program not found');
    });

    it('updates thread id on stopped events', () => {
        const adapter = new ZigAdapter(createDependencies());
        adapter.handleDapEvent({
            type: 'event',
            seq: 1,
            event: 'stopped',
            body: { threadId: 42 }
        });

        expect(adapter.getCurrentThreadId()).toBe(42);
    });

    it('supports standard debugging features', () => {
        const adapter = new ZigAdapter(createDependencies());

        expect(adapter.supportsFeature(DebugFeature.CONDITIONAL_BREAKPOINTS)).toBe(true);
        expect(adapter.supportsFeature(DebugFeature.FUNCTION_BREAKPOINTS)).toBe(true);
        expect(adapter.supportsFeature(DebugFeature.EVALUATE_FOR_HOVERS)).toBe(true);
        expect(adapter.supportsFeature(DebugFeature.LOG_POINTS)).toBe(false);
    });

    it('provides installation instructions', () => {
        const adapter = new ZigAdapter(createDependencies());

        expect(adapter.getInstallationInstructions()).toContain('brew install llvm');
        expect(adapter.getInstallationInstructions()).toContain('brew install zig');
        expect(adapter.getMissingExecutableError()).toContain('lldb-dap not found');
    });

    it('translates error messages', () => {
        const adapter = new ZigAdapter(createDependencies());

        expect(adapter.translateErrorMessage(new Error('lldb-dap not found'))).toContain('LLVM');
        expect(adapter.translateErrorMessage(new Error('Permission denied'))).toContain('Permission denied');
        expect(adapter.translateErrorMessage(new Error('program not found'))).toContain('zig build');
    });

    it('initializes successfully when environment validates', async () => {
        const adapter = new ZigAdapter(createDependencies());
        const existsSyncMock = fs.existsSync as unknown as Mock;
        const accessSyncMock = fs.accessSync as unknown as Mock;

        existsSyncMock.mockReturnValue(true);
        accessSyncMock.mockReturnValue(undefined);
        setupSpawnForValidation();

        const initialized = vi.fn();
        adapter.on('initialized', initialized);

        await adapter.initialize();

        expect(adapter.getState()).toBe(AdapterState.READY);
        expect(initialized).toHaveBeenCalled();
    });

    it('throws AdapterError when environment validation fails during initialize', async () => {
        const adapter = new ZigAdapter(createDependencies());
        const existsSyncMock = fs.existsSync as unknown as Mock;

        existsSyncMock.mockReturnValue(false);
        setupSpawnForValidation();

        await expect(adapter.initialize()).rejects.toBeInstanceOf(AdapterError);
        expect(adapter.getState()).toBe(AdapterState.ERROR);
    });

    it('updates state when connecting and disconnecting', async () => {
        const adapter = new ZigAdapter(createDependencies());
        const connected = vi.fn();
        const disconnected = vi.fn();
        adapter.on('connected', connected);
        adapter.on('disconnected', disconnected);

        await adapter.connect('localhost', 5678);
        expect(adapter.getState()).toBe(AdapterState.CONNECTED);
        expect(adapter.isConnected()).toBe(true);

        await adapter.disconnect();
        expect(adapter.getState()).toBe(AdapterState.DISCONNECTED);
        expect(adapter.isConnected()).toBe(false);
        expect(connected).toHaveBeenCalled();
        expect(disconnected).toHaveBeenCalled();
    });

    it('disposes by clearing state and emitting event', async () => {
        const adapter = new ZigAdapter(createDependencies());
        const disposed = vi.fn();
        adapter.on('disposed', disposed);

        await adapter.connect('localhost', 5678);
        await adapter.disconnect();
        await adapter.dispose();

        expect(disposed).toHaveBeenCalled();
        expect(adapter.getState()).toBe(AdapterState.UNINITIALIZED);
        expect(adapter.isConnected()).toBe(false);
    });

    it('exposes Zig capabilities', () => {
        const adapter = new ZigAdapter(createDependencies());
        const capabilities = adapter.getCapabilities();

        expect(capabilities.supportsConfigurationDoneRequest).toBe(true);
        expect(capabilities.supportsFunctionBreakpoints).toBe(true);
        expect(capabilities.supportsConditionalBreakpoints).toBe(true);
        expect(capabilities.supportsReadMemoryRequest).toBe(true);
        expect(capabilities.supportsDisassembleRequest).toBe(true);
    });

    it('returns default launch configuration', () => {
        const adapter = new ZigAdapter(createDependencies());
        const defaults = adapter.getDefaultLaunchConfig();

        expect(defaults.stopOnEntry).toBe(false);
        expect(defaults.cwd).toBe('${workspaceFolder}');
        expect(defaults.args).toEqual(['${workspaceFolder}/zig-out/bin/zig-harness']);
    });

    it('resolves executable path from cache', async () => {
        const adapter = new ZigAdapter(createDependencies());
        const existsSyncMock = fs.existsSync as unknown as Mock;
        const accessSyncMock = fs.accessSync as unknown as Mock;

        existsSyncMock.mockReturnValue(true);
        accessSyncMock.mockReturnValue(undefined);
        setupSpawnForValidation();

        // First call should find lldb-dap
        await adapter.validateEnvironment();

        // Second call should use cached path
        const path = await adapter.resolveExecutablePath();

        expect(path).toBeDefined();
        expect(path).toContain('lldb-dap');
    });

    it('uses preferred path if it exists', async () => {
        const adapter = new ZigAdapter(createDependencies());
        const existsSyncMock = fs.existsSync as unknown as Mock;

        existsSyncMock.mockReturnValue(true);

        const path = await adapter.resolveExecutablePath('/custom/path/lldb-dap');

        expect(path).toBe('/custom/path/lldb-dap');
    });

    it('returns required dependencies', () => {
        const adapter = new ZigAdapter(createDependencies());
        const deps = adapter.getRequiredDependencies();

        expect(deps).toHaveLength(2);
        expect(deps[0].name).toBe('lldb-dap');
        expect(deps[1].name).toBe('Zig');
    });

    it('searches common paths for lldb-dap', () => {
        const adapter = new ZigAdapter(createDependencies());
        const paths = adapter.getExecutableSearchPaths();

        expect(paths.length).toBeGreaterThan(0);
        expect(paths.some(p => p.includes('homebrew'))).toBe(true);
    });
});
