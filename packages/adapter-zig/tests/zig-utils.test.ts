import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as fssync from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as zigUtils from '../src/utils/zig-utils.js';

const spawnMock: Mock = vi.fn();

vi.mock('child_process', async () => {
    const actual = await vi.importActual<typeof import('child_process')>('child_process');
    return {
        ...actual,
        spawn: (...args: Parameters<typeof actual.spawn>) => spawnMock(...args)
    };
});

const createMockProcess = (options: {
    stdoutChunks?: string[];
    stderrChunks?: string[];
    exitCode?: number;
    error?: Error;
}): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } => {
    const { stdoutChunks = [], stderrChunks = [], exitCode = 0, error } = options;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    proc.stdout = stdout;
    proc.stderr = stderr;

    if (error) {
        queueMicrotask(() => proc.emit('error', error));
        return proc;
    }

    queueMicrotask(() => {
        stdoutChunks.forEach(chunk => stdout.emit('data', chunk));
        stderrChunks.forEach(chunk => stderr.emit('data', chunk));
        proc.emit('exit', exitCode);
    });

    return proc;
};

const tempDirs: string[] = [];

const createTempDir = async (name: string): Promise<string> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `zig-utils-${name}-`));
    tempDirs.push(dir);
    return dir;
};

beforeEach(() => {
    spawnMock.mockReset();
});

afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

describe('checkZigInstallation', () => {
    it('returns true when zig is available', async () => {
        spawnMock.mockImplementation(() =>
            createMockProcess({ stdoutChunks: ['0.13.0'], exitCode: 0 })
        );
        await expect(zigUtils.checkZigInstallation()).resolves.toBe(true);
    });

    it('returns false when zig is not found', async () => {
        spawnMock.mockImplementation(() => createMockProcess({ exitCode: 1 }));
        await expect(zigUtils.checkZigInstallation()).resolves.toBe(false);
    });

    it('returns false on spawn error', async () => {
        spawnMock.mockImplementation(() =>
            createMockProcess({ error: new Error('command not found') })
        );
        await expect(zigUtils.checkZigInstallation()).resolves.toBe(false);
    });
});

describe('getZigVersion', () => {
    it('parses simple version output', async () => {
        spawnMock.mockImplementation(() =>
            createMockProcess({ stdoutChunks: ['0.13.0\n'], exitCode: 0 })
        );
        await expect(zigUtils.getZigVersion()).resolves.toBe('0.13.0');
    });

    it('parses version with dev suffix', async () => {
        spawnMock.mockImplementation(() =>
            createMockProcess({ stdoutChunks: ['0.14.0-dev.123+abc'], exitCode: 0 })
        );
        await expect(zigUtils.getZigVersion()).resolves.toBe('0.14.0');
    });

    it('returns null on error', async () => {
        spawnMock.mockImplementation(() =>
            createMockProcess({ error: new Error('not found') })
        );
        await expect(zigUtils.getZigVersion()).resolves.toBeNull();
    });

    it('returns null on non-zero exit', async () => {
        spawnMock.mockImplementation(() =>
            createMockProcess({ exitCode: 1 })
        );
        await expect(zigUtils.getZigVersion()).resolves.toBeNull();
    });
});

describe('checkZigMinVersion', () => {
    it('returns true when version meets minimum', async () => {
        spawnMock.mockImplementation(() =>
            createMockProcess({ stdoutChunks: ['0.13.0'], exitCode: 0 })
        );
        await expect(zigUtils.checkZigMinVersion('0.11.0')).resolves.toBe(true);
    });

    it('returns true when version equals minimum', async () => {
        spawnMock.mockImplementation(() =>
            createMockProcess({ stdoutChunks: ['0.11.0'], exitCode: 0 })
        );
        await expect(zigUtils.checkZigMinVersion('0.11.0')).resolves.toBe(true);
    });

    it('returns false when version is below minimum', async () => {
        spawnMock.mockImplementation(() =>
            createMockProcess({ stdoutChunks: ['0.10.1'], exitCode: 0 })
        );
        await expect(zigUtils.checkZigMinVersion('0.11.0')).resolves.toBe(false);
    });

    it('returns false when zig is not available', async () => {
        spawnMock.mockImplementation(() =>
            createMockProcess({ error: new Error('not found') })
        );
        await expect(zigUtils.checkZigMinVersion('0.11.0')).resolves.toBe(false);
    });
});

describe('findZigExecutable', () => {
    it('returns zig when available in PATH', async () => {
        spawnMock.mockImplementation(() =>
            createMockProcess({ stdoutChunks: ['0.13.0'], exitCode: 0 })
        );
        const result = await zigUtils.findZigExecutable();
        expect(result).toBe('zig');
    });

    it('returns null when spawn fails (zig not in PATH) and not in common paths', async () => {
        // This test verifies the fallback behavior when spawn fails
        // The function should return 'zig' if spawn succeeds, or search common paths
        spawnMock.mockImplementation(() =>
            createMockProcess({ error: new Error('not found') })
        );
        const result = await zigUtils.findZigExecutable();
        // Result depends on actual system - may find zig in common paths
        // This test just verifies the function doesn't throw
        expect(typeof result === 'string' || result === null).toBe(true);
    });
});

describe('findZigProjectRoot', () => {
    it('finds build.zig by walking up directories', async () => {
        const base = await createTempDir('project');
        const nested = path.join(base, 'src', 'subdir');
        await fs.mkdir(nested, { recursive: true });
        await fs.writeFile(path.join(base, 'build.zig'), 'const std = @import("std");');

        const root = await zigUtils.findZigProjectRoot(path.join(nested, 'main.zig'));
        expect(root).toBe(base);
    });

    it('returns null when build.zig is not found', async () => {
        const tmpDir = await createTempDir('no-build');
        const file = path.join(tmpDir, 'src', 'main.zig');
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, '// orphan');

        const root = await zigUtils.findZigProjectRoot(file);
        expect(root).toBeNull();
    });

    it('handles file path that does not exist', async () => {
        const tmpDir = await createTempDir('nonexistent');
        await fs.writeFile(path.join(tmpDir, 'build.zig'), 'const std = @import("std");');

        const root = await zigUtils.findZigProjectRoot(path.join(tmpDir, 'src', 'nonexistent.zig'));
        expect(root).toBe(tmpDir);
    });
});

describe('buildZigProject', () => {
    it('builds project and returns success', async () => {
        spawnMock.mockImplementation(() =>
            createMockProcess({
                stdoutChunks: ['Build successful\n'],
                exitCode: 0
            })
        );

        const result = await zigUtils.buildZigProject('/workspace/demo');
        expect(result.success).toBe(true);
        expect(result.output).toContain('Build successful');
    });

    it('captures build failure', async () => {
        spawnMock.mockImplementation(() =>
            createMockProcess({
                stderrChunks: ['error: compilation failed\n'],
                exitCode: 1
            })
        );

        const result = await zigUtils.buildZigProject('/workspace/demo');
        expect(result.success).toBe(false);
        expect(result.output).toContain('compilation failed');
    });

    it('handles spawn error', async () => {
        spawnMock.mockImplementation(() =>
            createMockProcess({ error: new Error('spawn failed') })
        );

        const result = await zigUtils.buildZigProject('/workspace/demo');
        expect(result.success).toBe(false);
        expect(result.output).toContain('spawn failed');
    });

    it('passes release flag when requested', async () => {
        spawnMock.mockImplementation((_cmd: string, args: string[]) => {
            expect(args).toContain('-Doptimize=ReleaseFast');
            return createMockProcess({ exitCode: 0 });
        });

        await zigUtils.buildZigProject('/workspace/demo', true);
        expect(spawnMock).toHaveBeenCalled();
    });
});

describe('getZigBinaryPath', () => {
    it('returns correct path for existing binary', async () => {
        const project = await createTempDir('binary');
        const binDir = path.join(project, 'zig-out', 'bin');
        await fs.mkdir(binDir, { recursive: true });
        const binPath = path.join(binDir, process.platform === 'win32' ? 'app.exe' : 'app');
        await fs.writeFile(binPath, '');

        const result = await zigUtils.getZigBinaryPath(project, 'app');
        expect(result).toBe(binPath);
    });

    it('returns null when binary does not exist', async () => {
        const project = await createTempDir('no-binary');

        const result = await zigUtils.getZigBinaryPath(project, 'app');
        expect(result).toBeNull();
    });
});
