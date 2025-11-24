import {
    IDebugAdapter,
    IAdapterFactory,
    AdapterDependencies,
    AdapterMetadata,
    FactoryValidationResult,
    DebugLanguage
} from '@debugmcp/shared';
import { ZigAdapter } from './adapter.js';

export class ZigAdapterFactory implements IAdapterFactory {
    createAdapter(dependencies: AdapterDependencies): IDebugAdapter {
        return new ZigAdapter(dependencies);
    }

    getMetadata(): AdapterMetadata {
        return {
            language: DebugLanguage.ZIG,
            displayName: 'Zig',
            version: '0.1.0',
            author: 'mcp-debugger team',
            description: 'Debug Zig applications using lldb-dap',
            documentationUrl: 'https://github.com/debugmcp/mcp-debugger/docs/zig',
            minimumDebuggerVersion: '15.0.0', // LLVM version
            fileExtensions: ['.zig'],
            icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0OCA0OCI+PHBhdGggZmlsbD0iI0Y3QTEwMCIgZD0iTTcuNDIsNi45TDQsMTMuNWw5LjIsMGwzLjEsNC41bC05LjIsMGwtMy40LDYuNmw5LjIsMGwzLjEsNC41bC05LjIsMGwtMy40LDYuNmwzNS44LDBsMy40LTYuNmwtOS4yLDBsLTMuMS00LjVsOS4yLDBsMy40LTYuNmwtOS4yLDBsLTMuMS00LjVsOS4yLDBsMy40LTYuNkw3LjQyLDYuOXoiLz48L3N2Zz4=' // Zig logo placeholder
        };
    }

    async validate(): Promise<FactoryValidationResult> {
        // In a real implementation, check for lldb-dap
        return {
            valid: true,
            errors: [],
            warnings: [],
            details: {
                timestamp: new Date().toISOString()
            }
        };
    }
}
