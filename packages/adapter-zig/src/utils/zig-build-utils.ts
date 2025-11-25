/**
 * Zig build utilities
 *
 * Provides build detection, build.zig parsing, and build invocation.
 * Follows the same patterns as cargo-utils.ts for consistency.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';

/**
 * Zig target information extracted from build.zig
 */
export interface ZigTarget {
    name: string;           // Executable name from addExecutable
    rootSourceFile: string; // Main source file (if detected)
}

/**
 * Zig project information
 */
export interface ZigProject {
    root: string;           // Project root directory
    targets: ZigTarget[];   // List of executable targets
}

/**
 * Build result information
 */
export interface ZigBuildResult {
    success: boolean;
    binaryPath?: string;
    error?: string;
    output?: string;
}

/**
 * Parse build.zig to extract executable targets
 *
 * Looks for patterns like:
 *   b.addExecutable(.{ .name = "my-app" })
 *   const exe = b.addExecutable(.{
 *       .name = "my-app",
 *       ...
 *   });
 *
 * @param projectRoot - Path to the project root containing build.zig
 * @returns Array of targets found, or empty if parsing fails
 */
export async function parseZigBuildTargets(projectRoot: string): Promise<ZigTarget[]> {
    const buildZigPath = path.join(projectRoot, 'build.zig');

    try {
        const content = await fs.readFile(buildZigPath, 'utf-8');
        const targets: ZigTarget[] = [];

        // Pattern to match addExecutable with .name field
        // Handles both inline and multiline formats:
        //   b.addExecutable(.{ .name = "foo" })
        //   b.addExecutable(.{
        //       .name = "foo",
        //       ...
        //   })
        const addExecutablePattern = /addExecutable\s*\(\s*\.?\s*\{[^}]*?\.name\s*=\s*"([^"]+)"/gs;

        let match;
        while ((match = addExecutablePattern.exec(content)) !== null) {
            const name = match[1];
            // Avoid duplicates
            if (!targets.some(t => t.name === name)) {
                // Try to extract root_source_file if present
                const rootSourceFile = extractRootSourceFile(content, match.index) || 'main.zig';
                targets.push({ name, rootSourceFile });
            }
        }

        return targets;
    } catch {
        return [];
    }
}

/**
 * Try to extract the root_source_file from around the addExecutable call
 */
function extractRootSourceFile(content: string, startIndex: number): string | null {
    // Look for .root_source_file pattern near the addExecutable call
    // This is a best-effort extraction
    const searchArea = content.slice(startIndex, startIndex + 500);

    // Pattern: .root_source_file = b.path("main.zig")
    // or: .root_source_file = .{ .path = "src/main.zig" }
    const pathPatterns = [
        /\.root_source_file\s*=\s*b\.path\s*\(\s*"([^"]+)"\s*\)/,
        /\.root_source_file\s*=\s*\.?\s*\{\s*\.path\s*=\s*"([^"]+)"/,
        /root_module.*?\.root_source_file\s*=\s*b\.path\s*\(\s*"([^"]+)"\s*\)/s
    ];

    for (const pattern of pathPatterns) {
        const match = searchArea.match(pattern);
        if (match) {
            return match[1];
        }
    }

    return null;
}

/**
 * Resolve Zig project information including targets
 * @param projectPath - Path to project root
 * @returns Project info or null if not a valid Zig project
 */
export async function resolveZigProject(projectPath: string): Promise<ZigProject | null> {
    const buildZigPath = path.join(projectPath, 'build.zig');

    try {
        await fs.access(buildZigPath, fs.constants.F_OK);
        const targets = await parseZigBuildTargets(projectPath);

        return {
            root: projectPath,
            targets
        };
    } catch {
        return null;
    }
}

/**
 * Get the default binary name for a Zig project
 *
 * Priority:
 * 1. First executable target from build.zig parsing
 * 2. Directory name as fallback
 *
 * @param projectRoot - Path to project root
 * @returns Binary name
 */
export async function getDefaultBinary(projectRoot: string): Promise<string> {
    const targets = await parseZigBuildTargets(projectRoot);

    if (targets.length > 0) {
        return targets[0].name;
    }

    // Fallback to directory name
    return path.basename(projectRoot);
}

/**
 * Check if a Zig project needs rebuilding
 *
 * Compares binary mtime against:
 * - All .zig files in the project (recursively)
 * - build.zig file itself
 *
 * @param projectRoot - Path to project root
 * @param binaryName - Name of the binary (without extension)
 * @returns true if rebuild is needed
 */
export async function needsRebuild(
    projectRoot: string,
    binaryName: string
): Promise<boolean> {
    const binaryPath = getZigBinaryPath(projectRoot, binaryName);

    try {
        // Check if binary exists
        const binaryStats = await fs.stat(binaryPath);

        // Check build.zig modification time
        const buildZigPath = path.join(projectRoot, 'build.zig');
        const buildZigStats = await fs.stat(buildZigPath);
        if (buildZigStats.mtime > binaryStats.mtime) {
            return true;
        }

        // Check source file modification times
        // Look in common source locations
        const sourceDirs = [
            path.join(projectRoot, 'src'),
            projectRoot // For projects with main.zig at root
        ];

        for (const srcDir of sourceDirs) {
            try {
                const srcFiles = await getAllZigFiles(srcDir);
                for (const srcFile of srcFiles) {
                    const srcStats = await fs.stat(srcFile);
                    if (srcStats.mtime > binaryStats.mtime) {
                        return true;
                    }
                }
            } catch {
                // Directory doesn't exist, skip
            }
        }

        return false;
    } catch {
        // Binary doesn't exist or error accessing files
        return true;
    }
}

/**
 * Get all Zig source files recursively
 * @param dir - Directory to search
 * @returns Array of absolute paths to .zig files
 */
async function getAllZigFiles(dir: string): Promise<string[]> {
    const files: string[] = [];

    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            // Skip hidden directories and common non-source directories
            if (entry.name.startsWith('.') ||
                entry.name === 'zig-out' ||
                entry.name === 'zig-cache' ||
                entry.name === '.zig-cache') {
                continue;
            }

            if (entry.isDirectory()) {
                const subFiles = await getAllZigFiles(fullPath);
                files.push(...subFiles);
            } else if (entry.name.endsWith('.zig')) {
                files.push(fullPath);
            }
        }
    } catch {
        // Ignore errors reading directories
    }

    return files;
}

/**
 * Run zig build command
 * @param projectPath - Path to project root
 * @param args - Additional build arguments
 * @returns Build result with success flag and output
 */
export async function runZigBuild(
    projectPath: string,
    args: string[] = []
): Promise<{ success: boolean; output: string }> {
    return new Promise((resolve) => {
        const buildProcess = spawn('zig', ['build', ...args], {
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
 * Build Zig project with progress reporting
 *
 * @param projectRoot - Path to project root
 * @param logger - Optional logger for progress messages
 * @param buildMode - 'debug' (default) or 'release'
 * @returns Build result with binary path on success
 */
export async function buildZigProject(
    projectRoot: string,
    logger?: { info?: (msg: string) => void; error?: (msg: string) => void },
    buildMode: 'debug' | 'release' = 'debug'
): Promise<ZigBuildResult> {
    logger?.info?.(`[Zig Debugger] Building project at ${projectRoot}...`);

    const args: string[] = [];
    if (buildMode === 'release') {
        args.push('-Doptimize=ReleaseFast');
    }

    return new Promise((resolve) => {
        const buildProcess = spawn('zig', ['build', ...args], {
            cwd: projectRoot,
            shell: true
        });

        let stdout = '';
        let stderr = '';

        buildProcess.stdout?.on('data', (data) => {
            const msg = data.toString();
            stdout += msg;
            // Log meaningful progress
            if (msg.trim()) {
                logger?.info?.(`[Zig Build] ${msg.trim()}`);
            }
        });

        buildProcess.stderr?.on('data', (data) => {
            stderr += data.toString();
        });

        buildProcess.on('error', (error) => {
            const errorMsg = `Build process error: ${error.message}`;
            logger?.error?.(`[Zig Debugger] ${errorMsg}`);
            resolve({ success: false, error: errorMsg });
        });

        buildProcess.on('exit', async (code) => {
            if (code === 0) {
                try {
                    const binaryName = await getDefaultBinary(projectRoot);
                    const binaryPath = getZigBinaryPath(projectRoot, binaryName);

                    logger?.info?.(`[Zig Debugger] Build successful: ${binaryPath}`);
                    resolve({ success: true, binaryPath, output: stdout });
                } catch (error) {
                    const errorMsg = error instanceof Error ? error.message : String(error);
                    logger?.error?.(`[Zig Debugger] Failed to determine binary path: ${errorMsg}`);
                    resolve({ success: false, error: errorMsg });
                }
            } else {
                const errorMsg = stderr || stdout || `Build failed with code ${code}`;
                logger?.error?.(`[Zig Debugger] Build failed:\n${errorMsg}`);
                resolve({ success: false, error: errorMsg, output: stdout + stderr });
            }
        });
    });
}

/**
 * Get the path to the binary for a Zig project
 *
 * Standard Zig build output is: zig-out/bin/{binaryName}
 *
 * @param projectRoot - Path to project root
 * @param binaryName - Name of the binary
 * @returns Full path to binary (with platform-specific extension)
 */
export function getZigBinaryPath(projectRoot: string, binaryName: string): string {
    const extension = process.platform === 'win32' ? '.exe' : '';
    return path.join(projectRoot, 'zig-out', 'bin', `${binaryName}${extension}`);
}

/**
 * Find build.zig by walking up the directory tree
 *
 * @param filePath - Starting file path (e.g., a .zig source file)
 * @returns Project root directory
 * @throws Error if build.zig is not found
 */
export async function findZigProjectRoot(filePath: string): Promise<string> {
    let dir = path.dirname(path.resolve(filePath));
    const root = path.parse(dir).root;

    while (dir !== root) {
        const buildZig = path.join(dir, 'build.zig');
        try {
            await fs.access(buildZig);
            return dir;
        } catch {
            // Continue searching
        }
        const parentDir = path.dirname(dir);
        if (parentDir === dir) {
            break; // Reached the root
        }
        dir = parentDir;
    }

    throw new Error(`No build.zig found for ${filePath}`);
}
