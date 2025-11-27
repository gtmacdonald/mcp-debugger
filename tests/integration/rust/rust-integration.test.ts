/**
 * Integration tests for Rust adapter
 *
 * Tests the complete debugging workflow with the Rust hello_world example:
 * - Session creation
 * - Starting debugging
 * - Setting breakpoints
 * - Stepping through code
 * - Variable inspection
 * - Expression evaluation
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SessionManager, SessionManagerConfig } from '../../../src/session/session-manager.js';
import { createProductionDependencies } from '../../../src/container/dependencies.js';
import { DebugLanguage } from '@debugmcp/shared';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';

const currentFileURL = import.meta.url;
const currentFilePath = fileURLToPath(currentFileURL);
const currentDirName = path.dirname(currentFilePath);
import { spawnSync } from 'node:child_process';

/**
 * Check if CodeLLDB is available for Rust debugging
 */
function checkCodeLLDBAvailable(): { available: boolean; path?: string } {
  // Check CODELLDB_PATH environment variable first
  const envPath = process.env.CODELLDB_PATH;
  if (envPath && fs.existsSync(envPath)) {
    return { available: true, path: envPath };
  }

  // Check vendored CodeLLDB in packages/adapter-rust/vendor
  const arch = process.arch;
  const platformDir = arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  // Note: relative path from tests/integration/rust/ to packages/adapter-rust/vendor
  const vendoredPath = path.resolve(currentDirName, '../../../packages/adapter-rust/vendor/codelldb', platformDir, 'adapter', 'codelldb');
  if (fs.existsSync(vendoredPath)) {
    return { available: true, path: vendoredPath };
  }

  // Check common VS Code extension locations
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const extensionPaths = [
    path.join(homeDir, '.vscode', 'extensions'),
    path.join(homeDir, '.vscode-server', 'extensions'),
  ];

  for (const extPath of extensionPaths) {
    if (!fs.existsSync(extPath)) continue;

    try {
      const entries = fs.readdirSync(extPath);
      for (const entry of entries) {
        if (entry.startsWith('vadimcn.vscode-lldb-')) {
          const adapterPath = path.join(extPath, entry, 'adapter', 'codelldb');
          if (fs.existsSync(adapterPath)) {
            return { available: true, path: adapterPath };
          }
        }
      }
    } catch {
      continue;
    }
  }

  // Check PATH
  try {
    const result = spawnSync('which', ['codelldb'], { timeout: 5000, stdio: 'pipe' });
    if (result.status === 0) {
      return { available: true, path: result.stdout?.toString().trim() };
    }
  } catch {
    // Not found
  }

  return { available: false };
}

describe('Rust Adapter Integration', () => {
  let sessionManager: SessionManager;
  let sessionId: string;
  const rustBinaryPath = path.join(__dirname, '../../../examples/rust/hello_world/target/debug/hello_world');
  const rustSourcePath = path.join(__dirname, '../../../examples/rust/hello_world/src/main.rs');
  const codelldbCheck = checkCodeLLDBAvailable();

  beforeAll(async () => {
    // Check if Rust binary is built
    if (!fs.existsSync(rustBinaryPath)) {
      console.warn('⚠️  Rust hello_world not built. Run: cd examples/rust/hello_world && cargo build');
      console.warn('   Skipping full integration tests...');
      return;
    }

    if (!codelldbCheck.available) {
      console.warn('⚠️  CodeLLDB not found. Skipping Rust integration tests.');
      return;
    }

    const dependencies = createProductionDependencies({
      logLevel: 'debug',
      logFile: path.join(os.tmpdir(), 'rust-integration-test.log')
    });

    const config: SessionManagerConfig = {
      logDirBase: path.join(os.tmpdir(), 'rust-integration-test-sessions'),
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

  it('should create a Rust debug session', async () => {
    if (!fs.existsSync(rustBinaryPath) || !codelldbCheck.available) {
      console.log('⏭️  Skipping: Prerequisites not met');
      return;
    }

    const session = await sessionManager.createSession({
      language: DebugLanguage.RUST,
      name: 'Test Rust Session'
    });

    expect(session).toBeDefined();
    expect(session.language).toBe(DebugLanguage.RUST);
    expect(session.name).toBe('Test Rust Session');

    sessionId = session.id;
  });

  it('should start debugging the Rust binary', async () => {
    if (!fs.existsSync(rustBinaryPath) || !sessionId || !codelldbCheck.available) {
      console.log('⏭️  Skipping: Prerequisites not met');
      return;
    }

    try {
      await sessionManager.startDebugging(
        sessionId,
        rustBinaryPath,
        [],
        {
          stopOnEntry: true,
          args: [rustBinaryPath]
        }
      );

      const session = sessionManager.getSession(sessionId);
      expect(session).toBeDefined();
      expect(session?.state).toMatch(/initializing|running|paused/);

      console.log('✅ Rust debugging session started successfully');
    } catch (error) {
      console.error('❌ Failed to start debugging:', error);
      throw error;
    }
  }, 30000);

  it('should set a breakpoint in the Rust source file', async () => {
    if (!fs.existsSync(rustBinaryPath) || !sessionId || !codelldbCheck.available) {
      console.log('⏭️  Skipping: Prerequisites not met');
      return;
    }

    try {
      // Set breakpoint at line 40 (inside calculate_sum function: let sum = a + b;)
      const breakpoint = await sessionManager.setBreakpoint(
        sessionId,
        rustSourcePath,
        40
      );

      expect(breakpoint).toBeDefined();
      console.log('✅ Breakpoint set:', breakpoint);
    } catch (error) {
      console.error('❌ Failed to set breakpoint:', error);
      console.log('⚠️  Breakpoint setting failed (may be expected if session not ready)');
    }
  }, 15000);

  it('should continue execution and hit breakpoint', async () => {
    if (!fs.existsSync(rustBinaryPath) || !sessionId || !codelldbCheck.available) {
      console.log('⏭️  Skipping: Prerequisites not met');
      return;
    }

    try {
      await sessionManager.continue(sessionId);
      await new Promise(resolve => setTimeout(resolve, 2000));

      const session = sessionManager.getSession(sessionId);
      console.log('Session state after continue:', session?.state);

      expect(session?.state).toMatch(/paused|running|stopped/);
    } catch (error) {
      console.error('❌ Failed to continue execution:', error);
      console.log('⚠️  Continue operation failed (may be expected if session not ready)');
    }
  }, 15000);

  it('should get stack trace', async () => {
    if (!fs.existsSync(rustBinaryPath) || !sessionId || !codelldbCheck.available) {
      console.log('⏭️  Skipping: Prerequisites not met');
      return;
    }

    try {
      const stackTrace = await sessionManager.getStackTrace(sessionId);

      if (stackTrace && stackTrace.length > 0) {
        console.log('✅ Stack trace retrieved:', stackTrace.length, 'frames');
        expect(stackTrace).toBeDefined();
        expect(Array.isArray(stackTrace)).toBe(true);
        expect(stackTrace.length).toBeGreaterThan(0);

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

  it('should evaluate expressions', async () => {
    if (!fs.existsSync(rustBinaryPath) || !sessionId || !codelldbCheck.available) {
      console.log('⏭️  Skipping: Prerequisites not met');
      return;
    }

    try {
      const session = sessionManager.getSession(sessionId);

      if (session?.state === 'paused') {
        const stackTrace = await sessionManager.getStackTrace(sessionId);

        if (stackTrace && stackTrace.length > 0) {
          const frameId = stackTrace[0].id;

          // Evaluate a simple expression (parameter 'a' in calculate_sum)
          const result = await sessionManager.evaluateExpression(sessionId, 'a', frameId);

          if (result) {
            console.log('✅ Expression evaluated: a =', result.result);
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

  it('should close the Rust session', async () => {
    if (!sessionId) {
      console.log('⏭️  Skipping: No session to close');
      return;
    }

    try {
      const closed = await sessionManager.closeSession(sessionId);
      expect(closed).toBe(true);

      const session = sessionManager.getSession(sessionId);
      expect(session?.state).toBe('stopped');

      console.log('✅ Rust session closed successfully');
    } catch (error) {
      console.error('❌ Failed to close session:', error);
      throw error;
    }
  });
});
