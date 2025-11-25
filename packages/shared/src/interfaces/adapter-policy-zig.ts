/**
 * ZigAdapterPolicy - policy for Zig Debug Adapter (lldb-dap)
 */
import type { DebugProtocol } from '@vscode/debugprotocol';
import type { AdapterPolicy, AdapterSpecificState, CommandHandling } from './adapter-policy.js';
import { SessionState } from '@debugmcp/shared';
import type { StackFrame, Variable } from '../models/index.js';
import type { DapClientBehavior, DapClientContext, ReverseRequestResult } from './dap-client-behavior.js';

export const ZigAdapterPolicy: AdapterPolicy = {
    name: 'zig',
    supportsReverseStartDebugging: false,
    childSessionStrategy: 'none',
    shouldDeferParentConfigDone: () => false,
    buildChildStartArgs: () => {
        throw new Error('ZigAdapterPolicy does not support child sessions');
    },
    isChildReadyEvent: (evt: DebugProtocol.Event): boolean => {
        return evt?.event === 'initialized';
    },

    extractLocalVariables: (
        stackFrames: StackFrame[],
        scopes: Record<number, DebugProtocol.Scope[]>,
        variables: Record<number, Variable[]>,
        includeSpecial: boolean = false
    ): Variable[] => {
        if (!stackFrames || stackFrames.length === 0) return [];
        const topFrame = stackFrames[0];
        const frameScopes = scopes[topFrame.id];
        if (!frameScopes || frameScopes.length === 0) return [];

        // lldb-dap uses "Locals" or "Local"
        const localScope = frameScopes.find(scope =>
            scope.name === 'Local' || scope.name === 'Locals'
        );

        if (!localScope) return [];

        let localVars = variables[localScope.variablesReference] || [];

        if (!includeSpecial) {
            localVars = localVars.filter(v => !v.name.startsWith('$') && !v.name.startsWith('__'));
        }

        return localVars;
    },

    getLocalScopeName: (): string[] => ['Local', 'Locals'],

    getDapAdapterConfiguration: () => ({ type: 'lldb-dap' }),

    resolveExecutablePath: (providedPath?: string) => providedPath,

    getDebuggerConfiguration: () => ({
        requiresStrictHandshake: false,
        skipConfigurationDone: false,
        supportsVariableType: true
    }),

    isSessionReady: (state: SessionState) => state === SessionState.PAUSED,

    validateExecutable: async (_path: string): Promise<boolean> => {
        // Simplified validation
        return true;
    },

    requiresCommandQueueing: () => false,

    shouldQueueCommand: (): CommandHandling => ({
        shouldQueue: false,
        shouldDefer: false,
        reason: 'Zig/lldb-dap adapter does not queue commands'
    }),

    createInitialState: (): AdapterSpecificState => ({
        initialized: false,
        configurationDone: false
    }),

    updateStateOnCommand: (command: string, _args: unknown, state: AdapterSpecificState): void => {
        if (command === 'configurationDone') state.configurationDone = true;
    },

    updateStateOnEvent: (event: string, _body: unknown, state: AdapterSpecificState): void => {
        if (event === 'initialized') state.initialized = true;
    },

    isInitialized: (state: AdapterSpecificState): boolean => state.initialized,

    isConnected: (state: AdapterSpecificState): boolean => state.initialized,

    matchesAdapter: (adapterCommand: { command: string; args: string[] }): boolean => {
        const commandStr = adapterCommand.command.toLowerCase();
        return commandStr.includes('lldb-dap') || commandStr.includes('zig');
    },

    getInitializationBehavior: () => ({}),

    getDapClientBehavior: (): DapClientBehavior => ({
        handleReverseRequest: async (request: DebugProtocol.Request, context: DapClientContext): Promise<ReverseRequestResult> => {
            if (request.command === 'runInTerminal') {
                context.sendResponse(request, {});
                return { handled: true };
            }
            return { handled: false };
        },
        childRoutedCommands: undefined,
        mirrorBreakpointsToChild: false,
        deferParentConfigDone: false,
        pauseAfterChildAttach: false,
        normalizeAdapterId: undefined,
        childInitTimeout: 5000,
        suppressPostAttachConfigDone: false
    }),

    getAdapterSpawnConfig: (payload) => {
        if (payload.adapterCommand) {
            return {
                command: payload.adapterCommand.command,
                args: payload.adapterCommand.args,
                host: payload.adapterHost,
                port: payload.adapterPort,
                logDir: payload.logDir,
                env: payload.adapterCommand.env
            };
        }

        // Default spawn config for lldb-dap
        return {
            command: payload.executablePath || 'lldb-dap',
            args: [
                '--connection', `listen://${payload.adapterHost}:${payload.adapterPort}`
            ],
            host: payload.adapterHost,
            port: payload.adapterPort,
            logDir: payload.logDir,
            env: process.env
        };
    }
};
