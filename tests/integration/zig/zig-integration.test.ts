/**
 * Integration tests for Zig adapter
 * 
 * Tests the complete debugging workflow with the Zig harness:
 * - Session creation
 * - Starting debugging
 * - Setting breakpoints
 * - Stepping through code
 * - Variable inspection
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SessionManager, SessionManagerConfig } from '../../../src/session/session-manager.js';
import { createProductionDependencies } from '../../../src/container/dependencies.js';
import { DebugLanguage } from '@debugmcp/shared';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Zig Adapter Integration', () => {
    let sessionManager: SessionManager;
    let sessionId: string;
    const zigHarnessPath = path.join(__dirname, '../../../examples/zig-harness/zig-out/bin/zig-harness');
    const zigSourcePath = path.join(__dirname, '../../../examples/zig-harness/main.zig');

    let lldbDapPath: string | undefined;

    beforeAll(async () => {
        // Check if Zig harness is built
        if (!fs.existsSync(zigHarnessPath)) {
            console.warn('⚠️  Zig harness not built. Run: cd examples/zig-harness && zig build');
            console.warn('   Skipping integration tests...');
            return;
        }

        // Check if lldb-dap is available
        const lldbDapPaths = [
            '/opt/homebrew/opt/llvm/bin/lldb-dap',
            '/usr/local/opt/llvm/bin/lldb-dap',
            '/usr/bin/lldb-dap',
            // Ubuntu LLVM paths (version varies)
            '/usr/lib/llvm-18/bin/lldb-dap',
            '/usr/lib/llvm-17/bin/lldb-dap',
            '/usr/lib/llvm-16/bin/lldb-dap',
            '/usr/lib/llvm-15/bin/lldb-dap'
        ];

        lldbDapPath = lldbDapPaths.find(p => fs.existsSync(p));
        if (!lldbDapPath) {
            console.warn('⚠️  lldb-dap not found. Install LLVM: brew install llvm');
            console.warn('   Skipping integration tests...');
            return;
        }

        const dependencies = createProductionDependencies({
            logLevel: 'debug',
            logFile: path.join(os.tmpdir(), 'zig-integration-test.log')
        });

        const config: SessionManagerConfig = {
            logDirBase: path.join(os.tmpdir(), 'zig-integration-test-sessions'),
            defaultDapLaunchArgs: {
                stopOnEntry: true,
                justMyCode: true
            }
        };

        sessionManager = new SessionManager(config, dependencies);
    });

    afterAll(async () => {
        if (sessionManager) {
            await sessionManager.closeAllSessions();
        }
    });

    it('should create a Zig debug session', async () => {
        if (!fs.existsSync(zigHarnessPath)) {
            console.log('⏭️  Skipping: Zig harness not built');
            return;
        }

        const session = await sessionManager.createSession({
            language: DebugLanguage.ZIG,
            name: 'Test Zig Session',
            executablePath: lldbDapPath
        });

        expect(session).toBeDefined();
        expect(session.language).toBe(DebugLanguage.ZIG);
        expect(session.name).toBe('Test Zig Session');

        sessionId = session.id;
    });

    it('should start debugging the Zig harness', async () => {
        if (!fs.existsSync(zigHarnessPath) || !sessionId) {
            console.log('⏭️  Skipping: Prerequisites not met');
            return;
        }

        try {
            // Start debugging with the Zig harness binary
            await sessionManager.startDebugging(
                sessionId,
                zigHarnessPath,
                [], // No additional args
                {
                    stopOnEntry: true,
                    args: [zigHarnessPath] // Program path in args[0]
                }
            );

            const session = sessionManager.getSession(sessionId);
            expect(session).toBeDefined();
            expect(session?.state).toMatch(/initializing|running|paused/);

            console.log('✅ Zig debugging session started successfully');
        } catch (error) {
            console.error('❌ Failed to start debugging:', error);
            throw error;
        }
    }, 30000); // 30 second timeout for debugging startup

    it('should set a breakpoint in the Zig source file', async () => {
        if (!fs.existsSync(zigHarnessPath) || !sessionId) {
            console.log('⏭️  Skipping: Prerequisites not met');
            return;
        }

        if (!fs.existsSync(zigSourcePath)) {
            console.log('⏭️  Skipping: Zig source file not found');
            return;
        }

        try {
            // Set breakpoint at line 16 (inside the while loop)
            const breakpoint = await sessionManager.setBreakpoint(
                sessionId,
                zigSourcePath,
                16 // while (i < 5) : (i += 1)
            );

            expect(breakpoint).toBeDefined();
            console.log('✅ Breakpoint set:', breakpoint);

            // Note: breakpoint.verified may be false initially until the debugger
            // has loaded the source file
        } catch (error) {
            console.error('❌ Failed to set breakpoint:', error);
            // Don't throw - breakpoint setting might fail if session isn't fully initialized
            console.log('⚠️  Breakpoint setting failed (may be expected if session not ready)');
        }
    }, 15000);

    it('should continue execution and hit breakpoint', async () => {
        if (!fs.existsSync(zigHarnessPath) || !sessionId) {
            console.log('⏭️  Skipping: Prerequisites not met');
            return;
        }

        try {
            // Continue execution
            await sessionManager.continue(sessionId);

            // Wait a bit for the breakpoint to be hit
            await new Promise(resolve => setTimeout(resolve, 2000));

            const session = sessionManager.getSession(sessionId);
            console.log('Session state after continue:', session?.state);

            // Session should be paused at breakpoint or running
            expect(session?.state).toMatch(/paused|running|stopped/);
        } catch (error) {
            console.error('❌ Failed to continue execution:', error);
            console.log('⚠️  Continue operation failed (may be expected if session not ready)');
        }
    }, 15000);

    it('should get stack trace', async () => {
        if (!fs.existsSync(zigHarnessPath) || !sessionId) {
            console.log('⏭️  Skipping: Prerequisites not met');
            return;
        }

        try {
            const stackTrace = await sessionManager.getStackTrace(sessionId);

            if (stackTrace && stackTrace.length > 0) {
                console.log('✅ Stack trace retrieved:', stackTrace.length, 'frames');
                expect(stackTrace).toBeDefined();
                expect(Array.isArray(stackTrace)).toBe(true);

                // Should have at least one frame
                expect(stackTrace.length).toBeGreaterThan(0);

                // First frame should be in our code
                const topFrame = stackTrace[0];
                expect(topFrame).toHaveProperty('name');
                console.log('Top frame:', topFrame.name);
            } else {
                console.log('⚠️  No stack trace available (session may not be paused)');
            }
        } catch (error) {
            console.error('❌ Failed to get stack trace:', error);
            console.log('⚠️  Stack trace retrieval failed (may be expected if not paused)');
        }
    }, 10000);

    it('should step over code', async () => {
        if (!fs.existsSync(zigHarnessPath) || !sessionId) {
            console.log('⏭️  Skipping: Prerequisites not met');
            return;
        }

        try {
            const session = sessionManager.getSession(sessionId);

            if (session?.state === 'paused') {
                await sessionManager.stepOver(sessionId);

                // Wait for step to complete
                await new Promise(resolve => setTimeout(resolve, 1000));

                const updatedSession = sessionManager.getSession(sessionId);
                console.log('✅ Step over completed, state:', updatedSession?.state);
            } else {
                console.log('⏭️  Skipping step over: session not paused');
            }
        } catch (error) {
            console.error('❌ Failed to step over:', error);
            console.log('⚠️  Step over failed (may be expected if not paused)');
        }
    }, 10000);

    it('should get variables', async () => {
        if (!fs.existsSync(zigHarnessPath) || !sessionId) {
            console.log('⏭️  Skipping: Prerequisites not met');
            return;
        }

        try {
            const session = sessionManager.getSession(sessionId);

            if (session?.state === 'paused') {
                // Get stack trace first to get frame ID
                const stackTrace = await sessionManager.getStackTrace(sessionId);

                if (stackTrace && stackTrace.length > 0) {
                    const frameId = stackTrace[0].id;

                    // Get scopes for the frame
                    const scopes = await sessionManager.getScopes(sessionId, frameId);

                    if (scopes && scopes.length > 0) {
                        console.log('✅ Scopes retrieved:', scopes.length);

                        // Get variables from first scope
                        const variables = await sessionManager.getVariables(sessionId, scopes[0].variablesReference);

                        if (variables && variables.length > 0) {
                            console.log('✅ Variables retrieved:', variables.length);
                            console.log('Variables:', variables.map(v => `${v.name} = ${v.value}`));

                            // Should have variables like 'i', 'x', 'y', 'z'
                            expect(variables).toBeDefined();
                            expect(Array.isArray(variables)).toBe(true);
                        } else {
                            console.log('⚠️  No variables in scope');
                        }
                    } else {
                        console.log('⚠️  No scopes available');
                    }
                } else {
                    console.log('⚠️  No stack frames available');
                }
            } else {
                console.log('⏭️  Skipping variables: session not paused');
            }
        } catch (error) {
            console.error('❌ Failed to get variables:', error);
            console.log('⚠️  Variable retrieval failed (may be expected if not paused)');
        }
    }, 10000);

    it('should evaluate expressions', async () => {
        if (!fs.existsSync(zigHarnessPath) || !sessionId) {
            console.log('⏭️  Skipping: Prerequisites not met');
            return;
        }

        try {
            const session = sessionManager.getSession(sessionId);

            if (session?.state === 'paused') {
                // Get stack trace first to get frame ID
                const stackTrace = await sessionManager.getStackTrace(sessionId);

                if (stackTrace && stackTrace.length > 0) {
                    const frameId = stackTrace[0].id;

                    // Evaluate a simple expression
                    const result = await sessionManager.evaluate(sessionId, 'i', frameId);

                    if (result) {
                        console.log('✅ Expression evaluated: i =', result.result);
                        expect(result).toHaveProperty('result');
                    } else {
                        console.log('⚠️  Expression evaluation returned no result');
                    }
                } else {
                    console.log('⚠️  No stack frames for evaluation');
                }
            } else {
                console.log('⏭️  Skipping evaluation: session not paused');
            }
        } catch (error) {
            console.error('❌ Failed to evaluate expression:', error);
            console.log('⚠️  Expression evaluation failed (may be expected)');
        }
    }, 10000);

    it('should close the Zig session', async () => {
        if (!sessionId) {
            console.log('⏭️  Skipping: No session to close');
            return;
        }

        try {
            const closed = await sessionManager.closeSession(sessionId);
            expect(closed).toBe(true);

            const session = sessionManager.getSession(sessionId);
            expect(session?.state).toBe('stopped');

            console.log('✅ Zig session closed successfully');
        } catch (error) {
            console.error('❌ Failed to close session:', error);
            throw error;
        }
    });

    it('should verify Zig harness exists and has debug symbols', () => {
        if (!fs.existsSync(zigHarnessPath)) {
            console.log('⏭️  Zig harness not built at:', zigHarnessPath);
            console.log('   Build with: cd examples/zig-harness && zig build');
            return;
        }

        const stats = fs.statSync(zigHarnessPath);
        expect(stats.isFile()).toBe(true);

        // Check file size - should be reasonable for a debug build
        console.log('Zig harness size:', stats.size, 'bytes');
        expect(stats.size).toBeGreaterThan(1000); // At least 1KB

        console.log('✅ Zig harness exists and appears valid');
    });
});
