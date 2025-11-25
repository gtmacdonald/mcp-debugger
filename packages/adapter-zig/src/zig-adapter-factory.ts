/**
 * Zig Adapter Factory
 * 
 * Factory for creating Zig debug adapter instances.
 * Implements the adapter factory interface for dependency injection.
 * 
 * @since 2.0.0
 */
import {
    IDebugAdapter,
    IAdapterFactory,
    AdapterDependencies,
    AdapterMetadata,
    FactoryValidationResult,
    DebugLanguage
} from '@debugmcp/shared';
import { ZigAdapter } from './adapter.js';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export class ZigAdapterFactory implements IAdapterFactory {
    createAdapter(dependencies: AdapterDependencies): IDebugAdapter {
        return new ZigAdapter(dependencies);
    }

    getMetadata(): AdapterMetadata {
        return {
            language: DebugLanguage.ZIG,
            displayName: 'Zig',
            version: '1.0.0',
            author: 'mcp-debugger team',
            description: 'Debug Zig applications using lldb-dap',
            documentationUrl: 'https://github.com/debugmcp/mcp-debugger/docs/zig',
            minimumDebuggerVersion: '15.0.0', // LLVM version
            fileExtensions: ['.zig'],
            icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0OCA0OCI+PHBhdGggZmlsbD0iI0Y3QTEwMCIgZD0iTTcuNDIsNi45TDQsMTMuNWw5LjIsMGwzLjEsNC41bC05LjIsMGwtMy40LDYuNmw5LjIsMGwzLjEsNC41bC05LjIsMGwtMy40LDYuNmwzNS44LDBsMy40LTYuNmwtOS4yLDBsLTMuMS00LjVsOS4yLDBsMy40LTYuNmwtOS4yLDBsLTMuMS00LjVsOS4yLDBsMy40LTYuNkw3LjQyLDYuOXoiLz48L3N2Zz4='
        };
    }

    async validate(): Promise<FactoryValidationResult> {
        const errors: string[] = [];
        const warnings: string[] = [];
        let lldbDapPath: string | undefined;
        let lldbDapVersion: string | undefined;

        try {
            // Check for lldb-dap executable
            lldbDapPath = await this.findLldbDap() || undefined;

            if (!lldbDapPath) {
                errors.push('lldb-dap not found. Install LLVM: brew install llvm');
            } else {
                // Check lldb-dap version
                lldbDapVersion = await this.checkLldbDapVersion(lldbDapPath) || undefined;
                if (!lldbDapVersion) {
                    warnings.push('Could not determine lldb-dap version');
                }
            }

        } catch (error) {
            errors.push(error instanceof Error ? error.message : 'lldb-dap validation failed');
        }

        return {
            valid: errors.length === 0,
            errors,
            warnings,
            details: {
                lldbDapPath,
                lldbDapVersion,
                platform: process.platform,
                timestamp: new Date().toISOString()
            }
        };
    }

    /**
     * Find lldb-dap executable in common locations
     */
    private async findLldbDap(): Promise<string | null> {
        const searchPaths = this.getSearchPaths();
        const executableName = 'lldb-dap';

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
     * Get search paths for lldb-dap
     */
    private getSearchPaths(): string[] {
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

    /**
     * Check lldb-dap version
     */
    private checkLldbDapVersion(lldbDapPath: string): Promise<string | null> {
        return new Promise((resolve) => {
            const child = spawn(lldbDapPath, ['--version'], {
                stdio: ['ignore', 'pipe', 'pipe']
            });

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
        });
    }
}
