/**
 * Zig debugging utilities
 *
 * Provides toolchain validation and version checking for Zig.
 * Follows the same patterns as rust-utils.ts for consistency.
 */

import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';

/**
 * Check if Zig is installed and available in PATH
 */
export async function checkZigInstallation(): Promise<boolean> {
    return new Promise((resolve) => {
        const zigProcess = spawn('zig', ['version'], {
            stdio: 'ignore',
            shell: true
        });

        zigProcess.on('error', () => resolve(false));
        zigProcess.on('exit', (code) => resolve(code === 0));
    });
}

/**
 * Get Zig version string
 * @returns Version string (e.g., "0.13.0") or null if not available
 */
export async function getZigVersion(): Promise<string | null> {
    return new Promise((resolve) => {
        const zigProcess = spawn('zig', ['version'], {
            shell: true
        });

        let output = '';
        zigProcess.stdout?.on('data', (data) => {
            output += data.toString();
        });

        zigProcess.on('error', () => resolve(null));
        zigProcess.on('exit', (code) => {
            if (code === 0 && output) {
                // Parse version from "0.13.0" or "0.13.0+dev.123"
                const trimmed = output.trim();
                const match = trimmed.match(/^(\d+\.\d+\.\d+)/);
                resolve(match ? match[1] : trimmed);
            } else {
                resolve(null);
            }
        });
    });
}

/**
 * Compare two semantic version strings
 * @returns -1 if a < b, 0 if a == b, 1 if a > b
 */
function compareVersions(a: string, b: string): number {
    const partsA = a.split('.').map(Number);
    const partsB = b.split('.').map(Number);

    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
        const numA = partsA[i] || 0;
        const numB = partsB[i] || 0;
        if (numA < numB) return -1;
        if (numA > numB) return 1;
    }
    return 0;
}

/**
 * Check if Zig version meets minimum requirement
 * @param minVersion - Minimum version string (e.g., "0.11.0")
 * @returns true if installed version >= minVersion
 */
export async function checkZigMinVersion(minVersion: string): Promise<boolean> {
    const version = await getZigVersion();
    if (!version) return false;
    return compareVersions(version, minVersion) >= 0;
}

/**
 * Find Zig executable in PATH or common locations
 * @returns Path to zig executable or null if not found
 */
export async function findZigExecutable(): Promise<string | null> {
    // First, check if zig is available in PATH
    const isInstalled = await checkZigInstallation();
    if (isInstalled) {
        // Return 'zig' as it's in PATH
        return 'zig';
    }

    // Search common installation paths
    const searchPaths = getZigSearchPaths();

    for (const searchPath of searchPaths) {
        const zigPath = path.join(searchPath, getZigExecutableName());
        try {
            await fs.access(zigPath, fs.constants.X_OK);
            return zigPath;
        } catch {
            // Not found in this path, continue
        }
    }

    return null;
}

/**
 * Get platform-specific Zig executable name
 */
function getZigExecutableName(): string {
    return process.platform === 'win32' ? 'zig.exe' : 'zig';
}

/**
 * Get common Zig installation paths for the current platform
 */
function getZigSearchPaths(): string[] {
    const paths: string[] = [];

    if (process.platform === 'darwin') {
        // macOS paths
        paths.push(
            '/opt/homebrew/bin',           // Homebrew on Apple Silicon
            '/usr/local/bin',               // Homebrew on Intel
            '/opt/homebrew/opt/zig/bin',
            '/usr/local/opt/zig/bin'
        );
    } else if (process.platform === 'linux') {
        // Linux paths
        paths.push(
            '/usr/bin',
            '/usr/local/bin',
            path.join(process.env.HOME || '', '.local', 'bin'),
            '/snap/bin'
        );
    } else if (process.platform === 'win32') {
        // Windows paths
        paths.push(
            'C:\\Program Files\\zig',
            'C:\\zig',
            path.join(process.env.LOCALAPPDATA || '', 'zig')
        );
    }

    // Add PATH directories
    if (process.env.PATH) {
        paths.push(...process.env.PATH.split(path.delimiter));
    }

    return paths;
}

/**
 * Find Zig project root (containing build.zig)
 * @param startPath - Starting path to search from
 * @returns Project root directory or null if not found
 */
export async function findZigProjectRoot(startPath: string): Promise<string | null> {
    let currentPath = path.resolve(startPath);
    const root = path.parse(currentPath).root;

    // If startPath is a file, start from its directory
    try {
        const stat = await fs.stat(currentPath);
        if (stat.isFile()) {
            currentPath = path.dirname(currentPath);
        }
    } catch {
        // If stat fails, assume it's a path we should search from
        currentPath = path.dirname(currentPath);
    }

    while (currentPath !== root) {
        try {
            const buildZigPath = path.join(currentPath, 'build.zig');
            await fs.access(buildZigPath, fs.constants.F_OK);
            return currentPath;
        } catch {
            // Not found, move up
            const parentDir = path.dirname(currentPath);
            if (parentDir === currentPath) {
                break; // Reached the root
            }
            currentPath = parentDir;
        }
    }

    // Check root as well
    try {
        const buildZigPath = path.join(root, 'build.zig');
        await fs.access(buildZigPath, fs.constants.F_OK);
        return root;
    } catch {
        return null;
    }
}

/**
 * Build a Zig project using zig build
 * @param projectPath - Path to project root
 * @param release - Whether to build in release mode
 * @returns Build result with success flag and output
 */
export async function buildZigProject(
    projectPath: string,
    release: boolean = false
): Promise<{ success: boolean; output: string }> {
    return new Promise((resolve) => {
        const args = ['build'];
        if (release) {
            args.push('-Doptimize=ReleaseFast');
        }

        const buildProcess = spawn('zig', args, {
            cwd: projectPath,
            shell: true
        });

        let output = '';
        let errorOutput = '';

        buildProcess.stdout?.on('data', (data) => {
            output += data.toString();
        });

        buildProcess.stderr?.on('data', (data) => {
            errorOutput += data.toString();
        });

        buildProcess.on('error', (error) => {
            resolve({
                success: false,
                output: `Build failed: ${error.message}`
            });
        });

        buildProcess.on('exit', (code) => {
            resolve({
                success: code === 0,
                output: output + errorOutput
            });
        });
    });
}

/**
 * Get the path to a Zig compiled binary
 * @param projectPath - Path to project root
 * @param binaryName - Name of the binary
 * @returns Path to binary or null if not found
 */
export async function getZigBinaryPath(
    projectPath: string,
    binaryName: string
): Promise<string | null> {
    const extension = process.platform === 'win32' ? '.exe' : '';
    const binaryPath = path.join(projectPath, 'zig-out', 'bin', `${binaryName}${extension}`);

    try {
        await fs.access(binaryPath, fs.constants.F_OK);
        return binaryPath;
    } catch {
        return null;
    }
}
