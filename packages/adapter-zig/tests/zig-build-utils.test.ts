import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import * as zigBuildUtils from '../src/utils/zig-build-utils.js';
import * as fs from 'fs/promises';
import * as fssync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';

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
        queueMicrotask(() => {
            proc.emit('error', error);
        });
        return proc;
    }

    queueMicrotask(() => {
        stdoutChunks.forEach((chunk) => stdout.emit('data', chunk));
        stderrChunks.forEach((chunk) => stderr.emit('data', chunk));
        proc.emit('exit', exitCode);
    });

    return proc;
};

const tempDirs: string[] = [];

const createTempZigProject = async (name = 'zig-project', buildZigContent?: string): Promise<string> => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), `zig-build-${name}-`));
    tempDirs.push(base);
    await fs.mkdir(path.join(base, 'src'), { recursive: true });

    const defaultBuildZig = `const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const exe = b.addExecutable(.{
        .name = "${name}",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });

    b.installArtifact(exe);
}`;

    await fs.writeFile(path.join(base, 'build.zig'), buildZigContent || defaultBuildZig);
    await fs.writeFile(path.join(base, 'src', 'main.zig'), '// test main file');
    return base;
};

const withBinaryExtension = (name: string): string =>
    process.platform === 'win32' ? `${name}.exe` : name;

beforeEach(() => {
    spawnMock.mockReset();
});

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        try {
            fssync.rmSync(dir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
    }
});

describe('parseZigBuildTargets', () => {
    it('extracts executable name from addExecutable pattern', async () => {
        const project = await createTempZigProject('my-app');

        const targets = await zigBuildUtils.parseZigBuildTargets(project);
        expect(targets).toHaveLength(1);
        expect(targets[0].name).toBe('my-app');
    });

    it('handles inline addExecutable format', async () => {
        const buildZig = `const std = @import("std");
pub fn build(b: *std.Build) void {
    const exe = b.addExecutable(.{ .name = "inline-app", .root_module = b.createModule(.{ .root_source_file = b.path("main.zig") }) });
    b.installArtifact(exe);
}`;

        const project = await createTempZigProject('inline', buildZig);

        const targets = await zigBuildUtils.parseZigBuildTargets(project);
        expect(targets).toHaveLength(1);
        expect(targets[0].name).toBe('inline-app');
    });

    it('handles multiline build.zig format', async () => {
        const buildZig = `const std = @import("std");

pub fn build(b: *std.Build) void {
    const exe = b.addExecutable(.{
        .name = "multiline-app",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
        }),
    });

    b.installArtifact(exe);
}`;

        const project = await createTempZigProject('multiline', buildZig);

        const targets = await zigBuildUtils.parseZigBuildTargets(project);
        expect(targets).toHaveLength(1);
        expect(targets[0].name).toBe('multiline-app');
    });

    it('returns empty array when no targets found', async () => {
        const buildZig = `const std = @import("std");
pub fn build(b: *std.Build) void {
    // No executables defined
}`;

        const project = await createTempZigProject('no-targets', buildZig);

        const targets = await zigBuildUtils.parseZigBuildTargets(project);
        expect(targets).toEqual([]);
    });

    it('handles multiple executable targets', async () => {
        const buildZig = `const std = @import("std");
pub fn build(b: *std.Build) void {
    const exe1 = b.addExecutable(.{ .name = "app-one" });
    const exe2 = b.addExecutable(.{ .name = "app-two" });
    b.installArtifact(exe1);
    b.installArtifact(exe2);
}`;

        const project = await createTempZigProject('multi', buildZig);

        const targets = await zigBuildUtils.parseZigBuildTargets(project);
        expect(targets).toHaveLength(2);
        expect(targets.map(t => t.name)).toContain('app-one');
        expect(targets.map(t => t.name)).toContain('app-two');
    });

    it('returns empty array when build.zig does not exist', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'no-build-zig-'));
        tempDirs.push(dir);

        const targets = await zigBuildUtils.parseZigBuildTargets(dir);
        expect(targets).toEqual([]);
    });

    it('avoids duplicate target names', async () => {
        const buildZig = `const std = @import("std");
pub fn build(b: *std.Build) void {
    const exe = b.addExecutable(.{ .name = "duplicate" });
    const exe2 = b.addExecutable(.{ .name = "duplicate" });
}`;

        const project = await createTempZigProject('dupes', buildZig);

        const targets = await zigBuildUtils.parseZigBuildTargets(project);
        expect(targets).toHaveLength(1);
        expect(targets[0].name).toBe('duplicate');
    });
});

describe('resolveZigProject', () => {
    it('returns project info when build.zig exists', async () => {
        const project = await createTempZigProject('resolve-test');

        const result = await zigBuildUtils.resolveZigProject(project);
        expect(result).not.toBeNull();
        expect(result?.root).toBe(project);
        expect(result?.targets).toHaveLength(1);
    });

    it('returns null when build.zig does not exist', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'no-zig-project-'));
        tempDirs.push(dir);

        const result = await zigBuildUtils.resolveZigProject(dir);
        expect(result).toBeNull();
    });
});

describe('getDefaultBinary', () => {
    it('returns first executable target from build.zig', async () => {
        const project = await createTempZigProject('default-bin');

        const result = await zigBuildUtils.getDefaultBinary(project);
        expect(result).toBe('default-bin');
    });

    it('falls back to directory name when parsing fails', async () => {
        const buildZig = `const std = @import("std");
pub fn build(b: *std.Build) void {
    // No executables
}`;

        const project = await createTempZigProject('fallback-name', buildZig);

        const result = await zigBuildUtils.getDefaultBinary(project);
        expect(result).toBe(path.basename(project));
    });
});

describe('needsRebuild', () => {
    it('returns true when binary does not exist', async () => {
        const project = await createTempZigProject('needs-rebuild');

        const result = await zigBuildUtils.needsRebuild(project, 'needs-rebuild');
        expect(result).toBe(true);
    });

    it('returns true when source file is newer than binary', async () => {
        const project = await createTempZigProject('source-newer');
        const binDir = path.join(project, 'zig-out', 'bin');
        await fs.mkdir(binDir, { recursive: true });
        const binaryPath = path.join(binDir, withBinaryExtension('source-newer'));

        // Create binary first
        await fs.writeFile(binaryPath, '');

        // Wait a bit then update source
        await new Promise((resolve) => setTimeout(resolve, 10));
        await fs.writeFile(path.join(project, 'src', 'main.zig'), '// updated');

        const result = await zigBuildUtils.needsRebuild(project, 'source-newer');
        expect(result).toBe(true);
    });

    it('returns true when build.zig is newer than binary', async () => {
        const project = await createTempZigProject('build-newer');
        const binDir = path.join(project, 'zig-out', 'bin');
        await fs.mkdir(binDir, { recursive: true });
        const binaryPath = path.join(binDir, withBinaryExtension('build-newer'));

        // Create binary first
        await fs.writeFile(binaryPath, '');

        // Wait a bit then update build.zig
        await new Promise((resolve) => setTimeout(resolve, 10));
        await fs.writeFile(path.join(project, 'build.zig'), '// updated build.zig');

        const result = await zigBuildUtils.needsRebuild(project, 'build-newer');
        expect(result).toBe(true);
    });

    it('returns false when binary is newer than all sources', async () => {
        const project = await createTempZigProject('up-to-date');
        const binDir = path.join(project, 'zig-out', 'bin');
        await fs.mkdir(binDir, { recursive: true });

        // Write sources first
        await fs.writeFile(path.join(project, 'src', 'main.zig'), '// source');

        // Wait a bit then create binary
        await new Promise((resolve) => setTimeout(resolve, 10));
        const binaryPath = path.join(binDir, withBinaryExtension('up-to-date'));
        await fs.writeFile(binaryPath, '');

        const result = await zigBuildUtils.needsRebuild(project, 'up-to-date');
        expect(result).toBe(false);
    });
});

describe('runZigBuild', () => {
    it('returns build output and success flag', async () => {
        spawnMock.mockImplementation(() =>
            createMockProcess({
                stdoutChunks: ['Building...\n', 'Done.\n'],
                exitCode: 0
            })
        );

        const result = await zigBuildUtils.runZigBuild('/workspace/demo');
        expect(result.success).toBe(true);
        expect(result.output).toContain('Done');
    });

    it('captures failure output', async () => {
        spawnMock.mockImplementation(() =>
            createMockProcess({
                stderrChunks: ['error: undefined reference\n'],
                exitCode: 1
            })
        );

        const result = await zigBuildUtils.runZigBuild('/workspace/demo');
        expect(result.success).toBe(false);
        expect(result.output).toContain('undefined reference');
    });

    it('handles spawn errors gracefully', async () => {
        spawnMock.mockImplementation(() =>
            createMockProcess({
                error: new Error('spawn error')
            })
        );

        const result = await zigBuildUtils.runZigBuild('/workspace/demo');
        expect(result.success).toBe(false);
        expect(result.output).toContain('spawn error');
    });

    it('passes additional arguments', async () => {
        spawnMock.mockImplementation((_cmd: string, args: string[]) => {
            expect(args).toContain('-Doptimize=Debug');
            return createMockProcess({ exitCode: 0 });
        });

        await zigBuildUtils.runZigBuild('/workspace/demo', ['-Doptimize=Debug']);
        expect(spawnMock).toHaveBeenCalled();
    });
});

describe('buildZigProject', () => {
    it('returns binary path on successful build', async () => {
        const project = await createTempZigProject('build-success');

        spawnMock.mockImplementation(() =>
            createMockProcess({
                stdoutChunks: ['Building...\n'],
                exitCode: 0
            })
        );

        const logger = {
            info: vi.fn(),
            error: vi.fn()
        };

        const result = await zigBuildUtils.buildZigProject(project, logger);
        expect(result.success).toBe(true);
        const expectedBinary = withBinaryExtension('build-success');
        expect(result.binaryPath).toBe(
            path.join(project, 'zig-out', 'bin', expectedBinary)
        );
        expect((logger.info as Mock)).toHaveBeenCalled();
    });

    it('reports errors when build fails', async () => {
        const project = await createTempZigProject('build-fail');

        spawnMock.mockImplementation(() =>
            createMockProcess({
                stderrChunks: ['error: compilation failed\n'],
                exitCode: 1
            })
        );

        const logger = {
            info: vi.fn(),
            error: vi.fn()
        };

        const result = await zigBuildUtils.buildZigProject(project, logger);
        expect(result.success).toBe(false);
        expect(result.error).toContain('compilation failed');
        expect((logger.error as Mock)).toHaveBeenCalled();
    });

    it('logs progress messages', async () => {
        const project = await createTempZigProject('build-progress');

        spawnMock.mockImplementation(() =>
            createMockProcess({
                stdoutChunks: ['Compiling step 1\n', 'Compiling step 2\n'],
                exitCode: 0
            })
        );

        const logger = {
            info: vi.fn(),
            error: vi.fn()
        };

        await zigBuildUtils.buildZigProject(project, logger);
        expect((logger.info as Mock)).toHaveBeenCalled();
    });

    it('handles spawn errors gracefully', async () => {
        const project = await createTempZigProject('build-spawn-error');

        spawnMock.mockImplementation(() =>
            createMockProcess({
                error: new Error('spawn error')
            })
        );

        const logger = {
            info: vi.fn(),
            error: vi.fn()
        };

        const result = await zigBuildUtils.buildZigProject(project, logger);
        expect(result.success).toBe(false);
        expect(result.error).toContain('spawn error');
    });

    it('uses release optimization when buildMode is release', async () => {
        const project = await createTempZigProject('build-release');

        spawnMock.mockImplementation((_cmd: string, args: string[]) => {
            expect(args).toContain('-Doptimize=ReleaseFast');
            return createMockProcess({ exitCode: 0 });
        });

        await zigBuildUtils.buildZigProject(project, undefined, 'release');
        expect(spawnMock).toHaveBeenCalled();
    });
});

describe('getZigBinaryPath', () => {
    it('returns correct path with platform extension', () => {
        const expectedExtension = process.platform === 'win32' ? '.exe' : '';
        const result = zigBuildUtils.getZigBinaryPath('/project', 'my-app');
        expect(result).toBe(`/project/zig-out/bin/my-app${expectedExtension}`);
    });
});

describe('findZigProjectRoot', () => {
    it('walks up directories to locate build.zig', async () => {
        const project = await createTempZigProject('root-search');
        const nested = path.join(project, 'src', 'subdir');
        await fs.mkdir(nested, { recursive: true });
        const file = path.join(nested, 'helper.zig');
        await fs.writeFile(file, '// nested');

        const root = await zigBuildUtils.findZigProjectRoot(file);
        expect(root).toBe(project);
    });

    it('throws when build.zig is not found', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zig-no-root-'));
        tempDirs.push(tmpDir);
        const file = path.join(tmpDir, 'main.zig');
        await fs.writeFile(file, '// orphan');

        await expect(zigBuildUtils.findZigProjectRoot(file)).rejects.toThrowError(/build\.zig/);
    });
});
