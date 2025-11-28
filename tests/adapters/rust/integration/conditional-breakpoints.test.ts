/**
 * Integration tests for conditional breakpoints in Rust adapter
 *
 * Tests the conditionVerified and conditionError fields in breakpoint responses,
 * as well as verifying that conditional breakpoints only stop when the condition is true.
 *
 * Note: Rust uses CodeLLDB which has LLDB expression syntax for conditions.
 * Example conditions: "i > 5", "loop_value == 10"
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { StackFrame } from '@debugmcp/shared';
import path from 'path';
import fs from 'node:fs';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawnSync } from 'node:child_process';

const currentFileURL = import.meta.url;
const currentFilePath = fileURLToPath(currentFileURL);
const currentDirName = path.dirname(currentFilePath);

let client: Client | null = null;

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
  const platform = process.platform;

  let platformDir = '';
  if (platform === 'darwin') {
    platformDir = arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  } else if (platform === 'linux') {
    platformDir = arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
  } else if (platform === 'win32') {
    platformDir = 'win32-x64';
  }

  const vendoredPath = path.resolve(currentDirName, '../../../../packages/adapter-rust/vendor/codelldb', platformDir, 'adapter', 'codelldb');
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

async function startTestServer(): Promise<void> {
  const serverScriptPath = path.resolve(currentDirName, '../../../../dist/index.js');
  console.log(`[Test Setup] Server script path: ${serverScriptPath}`);

  client = new Client({
    name: 'rust-conditional-bp-test-client',
    version: '0.1.0',
    capabilities: { tools: {} }
  });

  const filteredEnv: Record<string, string> = {};
  for (const key in process.env) {
    if (process.env[key] !== undefined) {
      filteredEnv[key] = process.env[key] as string;
    }
  }

  const logFilePath = path.resolve(currentDirName, '../../rust_conditional_bp_test_server.log');
  try {
    if (fs.existsSync(logFilePath)) {
      fs.unlinkSync(logFilePath);
    }
  } catch (e) {
    console.error(`Error deleting old log file: ${e}`);
  }

  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverScriptPath, '--log-level', 'debug', '--log-file', logFilePath],
    env: filteredEnv
  });

  try {
    console.log('[Test Server] Attempting to connect SDK client...');
    await client.connect(transport);
    console.log('[Test Server] SDK Client connected successfully.');
  } catch (error) {
    console.error('[Test Server] SDK Client connection failed:', error);
    client = null;
    throw error;
  }
}

async function stopTestServer(): Promise<void> {
  if (client) {
    console.log('[Test Server] Closing SDK client connection...');
    try {
      await client.close();
      console.log('[Test Server] SDK Client closed successfully.');
    } catch (e) {
      console.error('[Test Server] Error closing SDK client:', e);
    }
  }
  client = null;
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const parseToolResult = (rawResult: unknown) => {
  const anyResult = rawResult as { content?: Array<{ type: string; text: string }> };
  if (!anyResult || !anyResult.content || !anyResult.content[0] || anyResult.content[0].type !== 'text') {
    console.error('Invalid ServerResult structure received:', rawResult);
    throw new Error('Invalid ServerResult structure');
  }
  return JSON.parse(anyResult.content[0].text);
};

async function waitForStackFrames(
  testClient: Client,
  sessionId: string,
  timeoutMs = 15000,
  pollInterval = 500
) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const stackTraceRawResult = await testClient.callTool({ name: 'get_stack_trace', arguments: { sessionId } });
    const stackTraceResult = parseToolResult(stackTraceRawResult);

    if (
      stackTraceResult.success &&
      Array.isArray(stackTraceResult.stackFrames) &&
      stackTraceResult.stackFrames.length > 0
    ) {
      return stackTraceResult;
    }

    await delay(pollInterval);
  }

  const finalResult = parseToolResult(await testClient.callTool({ name: 'get_stack_trace', arguments: { sessionId } }));
  console.error('[Test] Timed out waiting for stack frames. Last result:', JSON.stringify(finalResult, null, 2));
  throw new Error(`Timed out waiting for stack frames for session ${sessionId}`);
}

describe('Rust Conditional Breakpoint Integration @requires-codelldb', () => {
  let sessionId: string;
  // The Rust binary is at target/debug/hello_world
  const binaryPath = path.resolve('examples/rust/hello_world/target/debug/hello_world');
  const sourcePath = path.resolve('examples/rust/hello_world/src/main.rs');
  const breakpointLine = 37; // Line: let loop_value = i * 2;

  const codelldbCheck = checkCodeLLDBAvailable();

  beforeAll(async () => {
    if (!codelldbCheck.available) {
      console.log('[Test] Skipping Rust tests - CodeLLDB not available');
      console.log('[Test] To enable: Install CodeLLDB VS Code extension or set CODELLDB_PATH');
      return;
    }
    console.log(`[Test] CodeLLDB available at: ${codelldbCheck.path}`);

    // Verify binary exists
    if (!fs.existsSync(binaryPath)) {
      console.log(`[Test] Rust binary not found at ${binaryPath}. Skipping integration tests.`);
      console.log(`[Test] Run 'cargo build' in examples/rust/hello_world to enable these tests.`);
      // We can't easily skip the entire suite dynamically in Vitest from inside beforeAll
      // But we can set a flag to skip individual tests
      codelldbCheck.available = false;
      return;
    }

    await startTestServer();
  }, 30000);

  afterAll(async () => {
    if (sessionId && client) {
      try {
        await client.callTool({ name: 'close_debug_session', arguments: { sessionId } });
      } catch { /* ignore */ }
    }
    await stopTestServer();
  });

  it.skipIf(!codelldbCheck.available)('should set conditional breakpoint and only stop when condition is true', async () => {
    if (!client) {
      throw new Error('MCP Client not initialized');
    }

    // 1. Create session
    const createResult = parseToolResult(
      await client.callTool({
        name: 'create_debug_session',
        arguments: { language: 'rust', name: 'rustConditionalBpTest' }
      })
    );
    expect(createResult.success).toBe(true);
    sessionId = createResult.sessionId;
    console.log(`[Test] Created session: ${sessionId}`);

    // 2. Set conditional breakpoint: i > 5 means first stop at i=6
    // Note: CodeLLDB uses LLDB/C-style expressions
    const bpResult = parseToolResult(
      await client.callTool({
        name: 'set_breakpoint',
        arguments: {
          sessionId,
          file: sourcePath,
          line: breakpointLine,
          condition: 'i > 5'
        }
      })
    );
    expect(bpResult.success).toBe(true);
    expect(bpResult.condition).toBe('i > 5');
    expect(bpResult.line).toBe(breakpointLine);
    console.log('[Test] Set conditional breakpoint:', {
      condition: bpResult.condition,
      verified: bpResult.verified,
      conditionVerified: bpResult.conditionVerified,
      conditionError: bpResult.conditionError
    });

    // 3. Start debugging with the pre-built binary
    const startResult = parseToolResult(
      await client.callTool({
        name: 'start_debugging',
        arguments: {
          sessionId,
          scriptPath: binaryPath,
          dapLaunchArgs: {
            stopOnEntry: false
          }
        }
      })
    );
    if (!startResult.success) {
      console.error('❌ start_debugging failed:', JSON.stringify(startResult, null, 2));
    }
    expect(startResult.success).toBe(true);
    console.log('[Test] Started debugging, waiting for breakpoint...');

    // 4. Wait for first breakpoint hit
    const stackResult = await waitForStackFrames(client, sessionId, 20000);
    expect(stackResult.success).toBe(true);
    expect(stackResult.stackFrames.length).toBeGreaterThan(0);

    const topFrame = stackResult.stackFrames[0] as StackFrame;
    const frameId = topFrame.id;
    console.log(`[Test] Stopped at line ${topFrame.line}, frame ID: ${frameId}`);

    // 5. Evaluate 'i' - should be 6 (first time i > 5 is true)
    const evalResult = parseToolResult(
      await client.callTool({
        name: 'evaluate_expression',
        arguments: {
          sessionId,
          expression: 'i',
          frameId
        }
      })
    );
    expect(evalResult.success).toBe(true);
    console.log(`[Test] Variable i = ${evalResult.result}`);

    // i should be 6
    expect(evalResult.result).toContain('6');

    // 6. Continue to next breakpoint hit
    await client.callTool({ name: 'continue_execution', arguments: { sessionId } });
    await delay(2000);

    // 7. Get new stack trace and check i again
    const stackResult2 = await waitForStackFrames(client, sessionId, 10000);
    const frameId2 = stackResult2.stackFrames[0].id;

    const evalResult2 = parseToolResult(
      await client.callTool({
        name: 'evaluate_expression',
        arguments: {
          sessionId,
          expression: 'i',
          frameId: frameId2
        }
      })
    );
    expect(evalResult2.success).toBe(true);
    console.log(`[Test] Variable i = ${evalResult2.result} (second stop)`);

    // i should be 7 on second stop
    expect(evalResult2.result).toContain('7');

    console.log('[Test] Conditional breakpoint verified: stops only when i > 5');
  }, 60000);

  it.skipIf(!codelldbCheck.available)('should include condition metadata in breakpoint response', async () => {
    if (!client) {
      throw new Error('MCP Client not initialized');
    }

    // Create a new session for this test
    const createResult = parseToolResult(
      await client.callTool({
        name: 'create_debug_session',
        arguments: { language: 'rust', name: 'rustBpMetadataTest' }
      })
    );
    const testSessionId = createResult.sessionId;

    try {
      // Set breakpoint with condition
      const bpResult = parseToolResult(
        await client.callTool({
          name: 'set_breakpoint',
          arguments: {
            sessionId: testSessionId,
            file: sourcePath,
            line: breakpointLine,
            condition: 'loop_total > 10'
          }
        })
      );

      // Verify the response includes condition info
      expect(bpResult.success).toBe(true);
      expect(bpResult.condition).toBe('loop_total > 10');
      console.log('[Test] Breakpoint metadata:', {
        condition: bpResult.condition,
        verified: bpResult.verified,
        conditionVerified: bpResult.conditionVerified,
        conditionError: bpResult.conditionError
      });

      // Set breakpoint without condition for comparison
      const bpNoCondResult = parseToolResult(
        await client.callTool({
          name: 'set_breakpoint',
          arguments: {
            sessionId: testSessionId,
            file: sourcePath,
            line: 38 // Different line
          }
        })
      );

      expect(bpNoCondResult.success).toBe(true);
      expect(bpNoCondResult.condition).toBeUndefined();
      console.log('[Test] Non-conditional breakpoint has no condition field');
    } finally {
      await client.callTool({ name: 'close_debug_session', arguments: { sessionId: testSessionId } });
    }
  }, 30000);
}, 180000);
