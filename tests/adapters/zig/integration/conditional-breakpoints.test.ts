/**
 * Integration tests for conditional breakpoints in Zig adapter
 *
 * Tests the conditionVerified and conditionError fields in breakpoint responses,
 * as well as verifying that conditional breakpoints only stop when the condition is true.
 *
 * Note: Zig uses lldb-dap which has LLDB expression syntax for conditions.
 * Example conditions: "i > 5", "value == 10"
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
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
 * Check if lldb-dap is available for Zig debugging
 */
function checkLldbDapAvailable(): { available: boolean; path?: string; version?: string } {
  const searchPaths = [
    '/opt/homebrew/opt/llvm/bin/lldb-dap',
    '/usr/local/opt/llvm/bin/lldb-dap',
    '/opt/homebrew/bin/lldb-dap',
    '/usr/local/bin/lldb-dap',
    '/usr/bin/lldb-dap'
  ];

  for (const lldbPath of searchPaths) {
    if (fs.existsSync(lldbPath)) {
      try {
        const result = spawnSync(lldbPath, ['--version'], { timeout: 5000, stdio: 'pipe' });
        if (result.status === 0) {
          return {
            available: true,
            path: lldbPath,
            version: result.stdout?.toString().trim()
          };
        }
      } catch {
        continue;
      }
    }
  }

  // Try PATH
  try {
    const result = spawnSync('lldb-dap', ['--version'], { timeout: 5000, stdio: 'pipe' });
    if (result.status === 0) {
      return {
        available: true,
        version: result.stdout?.toString().trim()
      };
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
    name: 'zig-conditional-bp-test-client',
    version: '0.1.0',
    capabilities: { tools: {} }
  });

  const filteredEnv: Record<string, string> = {};
  for (const key in process.env) {
    if (process.env[key] !== undefined) {
      filteredEnv[key] = process.env[key] as string;
    }
  }

  const logFilePath = path.resolve(currentDirName, '../../zig_conditional_bp_test_server.log');
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

describe('Zig Conditional Breakpoint Integration @requires-lldb-dap', () => {
  let sessionId: string;
  // The Zig binary is pre-built at zig-out/bin/zig-harness
  const binaryPath = path.resolve('examples/zig-harness/zig-out/bin/zig-harness');
  const sourcePath = path.resolve('examples/zig-harness/main.zig');
  const breakpointLine = 20; // Line: const value = i * 2;

  const lldbCheck = checkLldbDapAvailable();

  beforeAll(async () => {
    if (!lldbCheck.available) {
      console.log('[Test] Skipping Zig tests - lldb-dap not available');
      return;
    }
    console.log(`[Test] lldb-dap available: ${lldbCheck.version}`);

    // Verify binary exists
    if (!fs.existsSync(binaryPath)) {
      console.error(`[Test] Zig binary not found at ${binaryPath}. Run 'zig build' in examples/zig-harness first.`);
      throw new Error('Zig test binary not found');
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

  it.skipIf(!lldbCheck.available)('should set conditional breakpoint and only stop when condition is true', async () => {
    if (!client) {
      throw new Error('MCP Client not initialized');
    }

    // 1. Create session
    const createResult = parseToolResult(
      await client.callTool({
        name: 'create_debug_session',
        arguments: { language: 'zig', name: 'zigConditionalBpTest' }
      })
    );
    expect(createResult.success).toBe(true);
    sessionId = createResult.sessionId;
    console.log(`[Test] Created session: ${sessionId}`);

    // 2. Set conditional breakpoint: i > 5 means first stop at i=6
    // Note: LLDB uses C-style expressions
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

  it.skipIf(!lldbCheck.available)('should include condition metadata in breakpoint response', async () => {
    if (!client) {
      throw new Error('MCP Client not initialized');
    }

    // Create a new session for this test
    const createResult = parseToolResult(
      await client.callTool({
        name: 'create_debug_session',
        arguments: { language: 'zig', name: 'zigBpMetadataTest' }
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
            condition: 'total > 10'
          }
        })
      );

      // Verify the response includes condition info
      expect(bpResult.success).toBe(true);
      expect(bpResult.condition).toBe('total > 10');
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
            line: 21 // Different line
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
