/**
 * Debug operations for session management including starting, stepping,
 * continuing, and breakpoint management.
 */
import { v4 as uuidv4 } from 'uuid';
import {
  Breakpoint,
  SessionState,
  SessionLifecycleState
} from '@debugmcp/shared';
import { ManagedSession, ToolchainValidationState } from './session-store.js';
import { DebugProtocol } from '@vscode/debugprotocol';
import path from 'path';
import { ProxyConfig } from '../proxy/proxy-config.js';
import { ErrorMessages } from '../utils/error-messages.js';
import { SessionManagerData } from './session-manager-data.js';
import { CustomLaunchRequestArguments, DebugResult } from './session-manager-core.js';
import {
  AdapterConfig,
  type GenericLaunchConfig,
  type LanguageSpecificLaunchConfig
} from '@debugmcp/shared';
import {
  SessionTerminatedError,
  ProxyNotRunningError,
  DebugSessionCreationError,
  PythonNotFoundError
} from '../errors/debug-errors.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

/**
 * Constants for expression evaluation preview formatting
 */
const PREVIEW_MAX_PROPERTIES = 5;
const PREVIEW_MAX_STRING_LENGTH = 200;
const PREVIEW_MAX_ARRAY_ITEMS = 3;
const PREVIEW_MAX_TOTAL_LENGTH = 4096;

/**
 * Structured error information for expression evaluation failures
 */
export interface EvaluateErrorInfo {
  category:
    // Python errors
    | 'SyntaxError' | 'NameError' | 'TypeError' | 'AttributeError'
    | 'IndexError' | 'KeyError' | 'ValueError' | 'RuntimeError'
    // JavaScript errors
    | 'ReferenceError' | 'RangeError'
    // LLDB/native debugger errors (Zig, Rust)
    | 'UndeclaredIdentifier' | 'NoMember' | 'ExpressionParseError' | 'LLDBError'
    // Generic fallback
    | 'Unknown';
  message: string;
  suggestion?: string;
  originalError: string;
}

/**
 * Result type for evaluate expression operations
 */
export interface EvaluateResult {
  success: boolean;
  result?: string;
  type?: string;
  /** Rich preview of the value with expanded properties (when available) */
  preview?: string;
  variablesReference?: number;
  namedVariables?: number;
  indexedVariables?: number;
  presentationHint?: DebugProtocol.VariablePresentationHint;
  error?: string;
  /** Structured error information with category and suggestions */
  errorInfo?: EvaluateErrorInfo;
}

/**
 * Debug operations functionality for session management
 */
export class SessionManagerOperations extends SessionManagerData {
  protected async startProxyManager(
    session: ManagedSession,
    scriptPath: string,
    scriptArgs?: string[],
    dapLaunchArgs?: Partial<CustomLaunchRequestArguments>,
    dryRunSpawn?: boolean,
    adapterLaunchConfig?: Record<string, unknown>
  ): Promise<LanguageSpecificLaunchConfig> {
    const sessionId = session.id;

    // Log entrance for Windows CI debugging
    this.logger.info(
      `[SessionManager] Entering startProxyManager for session ${sessionId}, dryRunSpawn: ${dryRunSpawn}, scriptPath: ${scriptPath}`
    );
    if (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') {
      console.error(`[SessionManager] Windows CI Debug - startProxyManager entrance:`, {
        sessionId,
        dryRunSpawn,
        scriptPath,
        language: session.language,
        hasBreakpoints: session.breakpoints?.size > 0,
        platform: process.platform,
        cwd: process.cwd()
      });
    }

    // Create session log directory
    const sessionLogDir = path.join(this.logDirBase, sessionId, `run-${Date.now()}`);
    this.logger.info(`[SessionManager] Ensuring session log directory: ${sessionLogDir}`);
    try {
      await this.fileSystem.ensureDir(sessionLogDir);
      const dirExists = await this.fileSystem.pathExists(sessionLogDir);
      if (!dirExists) {
        throw new Error(`Log directory ${sessionLogDir} could not be created`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[SessionManager] Failed to create log directory:`, err);
      throw new Error(`Failed to create session log directory: ${message}`);
    }
    // Persist log directory on session for diagnostics
    this.sessionStore.update(sessionId, { logDir: sessionLogDir });

    // Get free port for adapter
    const adapterPort = await this.findFreePort();

    const initialBreakpoints = Array.from(session.breakpoints.values()).map((bp) => {
      // Breakpoint file path has been validated by server.ts before reaching here
      return {
        file: bp.file, // Use the validated path
        line: bp.line,
        condition: bp.condition,
      };
    });

    // Merge launch args
    const effectiveLaunchArgs = {
      ...this.defaultDapLaunchArgs,
      ...(dapLaunchArgs || {}),
    };

    const genericLaunchConfig: Record<string, unknown> = {
      ...effectiveLaunchArgs,
      program: scriptPath
    };

    if (Array.isArray(scriptArgs) && scriptArgs.length > 0) {
      genericLaunchConfig.args = scriptArgs;
    }

    if (typeof genericLaunchConfig.cwd !== 'string' || genericLaunchConfig.cwd.length === 0) {
      genericLaunchConfig.cwd = path.dirname(scriptPath);
    }

    if (adapterLaunchConfig && typeof adapterLaunchConfig === 'object') {
      Object.assign(genericLaunchConfig, adapterLaunchConfig);
    }

    let transformedLaunchConfig: LanguageSpecificLaunchConfig | undefined;

    // Create the adapter for this language first
    const adapterConfig: AdapterConfig = {
      sessionId,
      executablePath: '', // Will be resolved by adapter
      adapterHost: '127.0.0.1',
      adapterPort,
      logDir: sessionLogDir,
      scriptPath,
      scriptArgs,
      launchConfig: genericLaunchConfig as GenericLaunchConfig,
    };

    const adapter = await this.adapterRegistry.create(session.language, adapterConfig);

    try {
      transformedLaunchConfig = await adapter.transformLaunchConfig(genericLaunchConfig as GenericLaunchConfig);
    } catch (error) {
      this.logger.warn(
        `[SessionManager] transformLaunchConfig failed for ${session.language}: ${error instanceof Error ? error.message : String(error)
        }`
      );
      transformedLaunchConfig = undefined;
    }

    const adapterWithToolchain = adapter as {
      consumeLastToolchainValidation?: () => unknown;
    };
    const toolchainValidation =
      typeof adapterWithToolchain.consumeLastToolchainValidation === 'function'
        ? (adapterWithToolchain.consumeLastToolchainValidation() as ToolchainValidationState)
        : undefined;

    if (toolchainValidation) {
      this.sessionStore.update(sessionId, { toolchainValidation });
      if (!toolchainValidation.compatible && toolchainValidation.behavior !== 'continue') {
        const toolchainError = new Error('MSVC_TOOLCHAIN_DETECTED') as Error & {
          toolchainValidation?: ToolchainValidationState;
        };
        toolchainError.toolchainValidation = toolchainValidation;
        throw toolchainError;
      }
    } else {
      this.sessionStore.update(sessionId, { toolchainValidation: undefined });
    }

    // Use the adapter to resolve the executable path
    let resolvedExecutablePath: string;
    try {
      resolvedExecutablePath = await adapter.resolveExecutablePath(session.executablePath);
      this.logger.info(`[SessionManager] Adapter resolved executable path: ${resolvedExecutablePath}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `[SessionManager] Failed to resolve executable for ${session.language}:`,
        msg
      );

      // Convert to appropriate error type based on language
      if (session.language === 'python' && msg.includes('not found')) {
        throw new PythonNotFoundError(session.executablePath || 'python');
      }

      throw new DebugSessionCreationError(
        `Failed to resolve ${session.language} executable: ${msg}`,
        error instanceof Error ? error : undefined
      );
    }

    // Update adapter config with resolved executable path
    adapterConfig.executablePath = resolvedExecutablePath;

    // Build adapter command using the adapter
    const adapterCommand = adapter.buildAdapterCommand(adapterConfig);

    const launchConfigBase =
      transformedLaunchConfig ?? (genericLaunchConfig as LanguageSpecificLaunchConfig);
    const launchConfigData: LanguageSpecificLaunchConfig = { ...launchConfigBase };

    const languageId = typeof session.language === 'string'
      ? session.language.toLowerCase()
      : String(session.language).toLowerCase();
    const isJavascriptSession = languageId === 'javascript';
    const stopOnEntryProvided = typeof dapLaunchArgs?.stopOnEntry === 'boolean';

    if (isJavascriptSession && !stopOnEntryProvided) {
      launchConfigData.stopOnEntry = false;
      if (Array.isArray(launchConfigData.runtimeArgs)) {
        launchConfigData.runtimeArgs = (launchConfigData.runtimeArgs as string[]).filter(
          arg => !/^--inspect(?:-brk)?(?:=|$)/.test(arg)
        );
      }
    }

    this.logger.info(
      `[SessionManager] Launch config stopOnEntry adjustments for ${sessionId}: base=${String(
        launchConfigBase?.stopOnEntry
      )}, final=${String(launchConfigData.stopOnEntry)}, userProvided=${String(
        dapLaunchArgs?.stopOnEntry
      )}`
    );

    const stopOnEntryFlag =
      typeof launchConfigData?.stopOnEntry === 'boolean'
        ? launchConfigData.stopOnEntry
        : effectiveLaunchArgs.stopOnEntry;

    const justMyCodeFlag =
      typeof launchConfigData?.justMyCode === 'boolean'
        ? launchConfigData.justMyCode
        : effectiveLaunchArgs.justMyCode;

    // Create ProxyConfig
    const programFromLaunchConfig =
      typeof launchConfigData?.program === 'string' && launchConfigData.program.length > 0
        ? launchConfigData.program
        : scriptPath;

    const argsFromLaunchConfig = Array.isArray(launchConfigData?.args)
      ? (launchConfigData!.args as unknown[]).filter((arg): arg is string => typeof arg === 'string')
      : Array.isArray(scriptArgs)
        ? [...scriptArgs]
        : [];

    const normalizedScriptArgs = argsFromLaunchConfig.length > 0 ? argsFromLaunchConfig : undefined;

    if (initialBreakpoints.length) {
      this.logger.info(
        `[SessionManager] Initial breakpoints for ${sessionId}:`,
        initialBreakpoints.map(bp => ({ file: bp.file, line: bp.line }))
      );
    }

    const proxyConfig: ProxyConfig = {
      sessionId,
      language: session.language, // Add language from session
      executablePath: resolvedExecutablePath,
      adapterHost: '127.0.0.1',
      adapterPort,
      logDir: sessionLogDir,
      scriptPath: programFromLaunchConfig,
      scriptArgs: normalizedScriptArgs,
      stopOnEntry: stopOnEntryFlag,
      justMyCode: justMyCodeFlag,
      initialBreakpoints,
      dryRunSpawn: dryRunSpawn === true,
      launchConfig: launchConfigData,
      adapterCommand, // Pass the adapter command
    };

    // Create and start ProxyManager with the adapter
    const proxyManager = this.proxyManagerFactory.create(adapter);
    session.proxyManager = proxyManager;

    // Set up event handlers
    this.setupProxyEventHandlers(session, proxyManager, effectiveLaunchArgs);

    // Start the proxy
    await proxyManager.start(proxyConfig);

    return launchConfigData;
  }

  /**
   * Helper method to wait for dry run completion with timeout
   */
  private async waitForDryRunCompletion(
    session: ManagedSession,
    timeoutMs: number
  ): Promise<boolean> {
    if (session.proxyManager?.hasDryRunCompleted?.()) {
      this.logger.info(
        `[SessionManager] Dry run already marked complete for session ${session.id} before wait`
      );
      return true;
    }

    let handler: (() => void) | null = null;
    let timeoutId: NodeJS.Timeout | null = null;

    try {
      return await Promise.race([
        new Promise<boolean>((resolve) => {
          handler = () => {
            this.logger.info(
              `[SessionManager] Dry run completion event received for session ${session.id}`
            );
            resolve(true);
          };
          this.logger.info(
            `[SessionManager] Setting up dry-run-complete listener for session ${session.id}`
          );
          session.proxyManager?.once('dry-run-complete', handler);
        }),
        new Promise<boolean>((resolve) => {
          timeoutId = setTimeout(() => {
            if (session.proxyManager?.hasDryRunCompleted?.()) {
              this.logger.info(
                `[SessionManager] Dry run marked complete during timeout window for session ${session.id}`
              );
              resolve(true);
              return;
            }
            this.logger.warn(
              `[SessionManager] Dry run timeout after ${timeoutMs}ms for session ${session.id}`
            );
            resolve(false);
          }, timeoutMs);
        }),
      ]);
    } finally {
      // Clean up immediately
      if (handler && session.proxyManager) {
        this.logger.info(
          `[SessionManager] Removing dry-run-complete listener for session ${session.id}`
        );
        session.proxyManager.removeListener('dry-run-complete', handler);
      }
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  async startDebugging(
    sessionId: string,
    scriptPath: string,
    scriptArgs?: string[],
    dapLaunchArgs?: Partial<CustomLaunchRequestArguments>,
    dryRunSpawn?: boolean,
    adapterLaunchConfig?: Record<string, unknown>
  ): Promise<DebugResult> {
    const session = this._getSessionById(sessionId);
    this.logger.info(
      `Attempting to start debugging for session ${sessionId}, script: ${scriptPath}, dryRunSpawn: ${dryRunSpawn}, dapLaunchArgs:`,
      dapLaunchArgs
    );

    // CI Debug: Entry point
    if (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') {
      console.error(`[CI Debug] startDebugging entry - sessionId: ${sessionId}, dryRunSpawn: ${dryRunSpawn}, scriptPath: ${scriptPath}`);
    }

    if (session.proxyManager) {
      this.logger.warn(
        `[SessionManager] Session ${sessionId} already has an active proxy. Terminating before starting new.`
      );
      await this.closeSession(sessionId);
    }

    // Update to INITIALIZING state and set lifecycle to ACTIVE
    this._updateSessionState(session, SessionState.INITIALIZING);

    // Explicitly set lifecycle state to ACTIVE when starting debugging
    this.sessionStore.update(sessionId, {
      sessionLifecycle: SessionLifecycleState.ACTIVE,
    });
    this.logger.info(`[SessionManager] Session ${sessionId} lifecycle state set to ACTIVE`);

    try {
      // For dry run, start the proxy and wait for completion
      if (dryRunSpawn) {
        // CI Debug: Entering dry run branch
        if (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') {
          console.error(`[CI Debug] Entering dry run branch for session ${sessionId}`);
        }

        // Mark that we're setting up a dry run handler
        const sessionWithSetup = session as ManagedSession & { _dryRunHandlerSetup?: boolean };
        sessionWithSetup._dryRunHandlerSetup = true;

        // CI Debug: Before startProxyManager
        if (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') {
          console.error(`[CI Debug] About to call startProxyManager for dry run`);
        }

        // Start the proxy manager
        await this.startProxyManager(session, scriptPath, scriptArgs, dapLaunchArgs, dryRunSpawn, adapterLaunchConfig);
        this.logger.info(`[SessionManager] ProxyManager started for session ${sessionId}`);

        // CI Debug: After startProxyManager
        if (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') {
          console.error(`[CI Debug] startProxyManager completed, checking state`);
        }

        // Check if already completed before waiting
        const refreshedSession = this._getSessionById(sessionId);
        this.logger.info(`[SessionManager] Checking state after start: ${refreshedSession.state}`);

        // CI Debug: State check
        if (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') {
          console.error(`[CI Debug] Session state after proxy start: ${refreshedSession.state}`);
        }

        const initialDryRunSnapshot = refreshedSession.proxyManager?.getDryRunSnapshot?.();
        const dryRunAlreadyComplete =
          refreshedSession.state === SessionState.STOPPED ||
          refreshedSession.proxyManager?.hasDryRunCompleted?.() === true;

        if (dryRunAlreadyComplete) {
          this.logger.info(
            `[SessionManager] Dry run already completed for session ${sessionId}`
          );
          delete sessionWithSetup._dryRunHandlerSetup;

          // CI Debug: Early completion
          if (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') {
            console.error(`[CI Debug] Dry run completed immediately (state=STOPPED)`);
          }

          return {
            success: true,
            state: SessionState.STOPPED,
            data: {
              dryRun: true,
              message: 'Dry run spawn command logged by proxy.',
              command: initialDryRunSnapshot?.command,
              script: initialDryRunSnapshot?.script,
            },
          };
        }

        // Wait for completion with timeout
        this.logger.info(
          `[SessionManager] Waiting for dry run completion with timeout ${this.dryRunTimeoutMs}ms`
        );

        // CI Debug: Before wait
        if (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') {
          console.error(`[CI Debug] Waiting for dry run completion, timeout: ${this.dryRunTimeoutMs}ms`);
        }

        const dryRunCompleted = await this.waitForDryRunCompletion(
          refreshedSession,
          this.dryRunTimeoutMs
        );
        delete sessionWithSetup._dryRunHandlerSetup;

        // CI Debug: After wait
        if (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') {
          console.error(`[CI Debug] waitForDryRunCompletion returned: ${dryRunCompleted}`);
        }

        const latestSessionState = this._getSessionById(sessionId);
        const latestSnapshot =
          latestSessionState.proxyManager?.getDryRunSnapshot?.() ?? initialDryRunSnapshot;
        const effectiveDryRunComplete =
          dryRunCompleted ||
          latestSessionState.state === SessionState.STOPPED ||
          latestSessionState.proxyManager?.hasDryRunCompleted?.() === true;

        if (effectiveDryRunComplete) {
          this.logger.info(
            `[SessionManager] Dry run completed for session ${sessionId}, final state: ${latestSessionState.state}`
          );

          // CI Debug: Success path
          if (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') {
            console.error(`[CI Debug] Dry run success path - returning success`);
          }

          return {
            success: true,
            state: SessionState.STOPPED,
            data: {
              dryRun: true,
              message: 'Dry run spawn command logged by proxy.',
              command: latestSnapshot?.command,
              script: latestSnapshot?.script,
            },
          };
        } else {
          // Timeout occurred
          const finalSession = latestSessionState;
          this.logger.error(
            `[SessionManager] Dry run timeout for session ${sessionId}. ` +
            `State: ${finalSession.state}, ProxyManager active: ${!!finalSession.proxyManager}`
          );

          // CI Debug: Timeout path
          if (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') {
            console.error(`[CI Debug] Dry run timeout! State: ${finalSession.state}, ProxyManager: ${!!finalSession.proxyManager}`);
          }

          return {
            success: false,
            error: `Dry run timed out after ${this.dryRunTimeoutMs}ms. Current state: ${finalSession.state}`,
            state: finalSession.state,
          };
        }
      }

      // Normal (non-dry-run) flow
      // Start the proxy manager
      const launchConfigData = await this.startProxyManager(session, scriptPath, scriptArgs, dapLaunchArgs, dryRunSpawn, adapterLaunchConfig);
      this.logger.info(`[SessionManager] ProxyManager started for session ${sessionId}`);

      // Perform language-specific handshake if required
      const policy = this.selectPolicy(session.language);
      if (policy.performHandshake) {
        try {
          await policy.performHandshake({
            proxyManager: session.proxyManager,
            sessionId: session.id,
            dapLaunchArgs,
            scriptPath,
            scriptArgs,
            breakpoints: session.breakpoints,
            launchConfig: launchConfigData
          });
        } catch (handshakeErr) {
          this.logger.warn(
            `[SessionManager] Language handshake returned with warning/error: ${handshakeErr instanceof Error ? handshakeErr.message : String(handshakeErr)
            }`
          );
        }
      }

      // Use policy-defined readiness criteria when available.
      const sessionStateAfterHandshake = this._getSessionById(sessionId).state;
      const alreadyReady = policy.isSessionReady
        ? policy.isSessionReady(sessionStateAfterHandshake, { stopOnEntry: dapLaunchArgs?.stopOnEntry })
        : sessionStateAfterHandshake === SessionState.PAUSED;

      if (!alreadyReady) {
        // Wait for adapter to be configured or first stop event
        const waitForReady = new Promise<void>((resolve) => {
          let resolved = false;

          const handleStopped = () => {
            if (!resolved) {
              resolved = true;
              this.logger.info(`[SessionManager] Session ${sessionId} stopped on entry`);
              resolve();
            }
          };

          const handleConfigured = () => {
            const readyOnRunning = policy.isSessionReady
              ? policy.isSessionReady(SessionState.RUNNING, { stopOnEntry: dapLaunchArgs?.stopOnEntry })
              : !dapLaunchArgs?.stopOnEntry;
            if (!resolved && readyOnRunning) {
              resolved = true;
              this.logger.info(
                `[SessionManager] Session ${sessionId} running (stopOnEntry=${dapLaunchArgs?.stopOnEntry ?? false})`
              );
              resolve();
            }
          };

          session.proxyManager?.once('stopped', handleStopped);
          session.proxyManager?.once('adapter-configured', handleConfigured);

          // In case the adapter already reached the desired state before listeners were attached,
          // perform a synchronous state check to avoid waiting for an event that already fired.
          const currentState = this._getSessionById(sessionId).state;
          const readyNow = policy.isSessionReady
            ? policy.isSessionReady(currentState, { stopOnEntry: dapLaunchArgs?.stopOnEntry })
            : currentState === SessionState.PAUSED;
          if (readyNow) {
            resolved = true;
            session.proxyManager?.removeListener('stopped', handleStopped);
            session.proxyManager?.removeListener('adapter-configured', handleConfigured);
            resolve();
            return;
          }

          // Timeout after 30 seconds
          setTimeout(() => {
            if (!resolved) {
              resolved = true;
              session.proxyManager?.removeListener('stopped', handleStopped);
              session.proxyManager?.removeListener('adapter-configured', handleConfigured);
              this.logger.warn(ErrorMessages.adapterReadyTimeout(30));
              resolve();
            }
          }, 30000);
        });

        await waitForReady;
      } else {
        this.logger.info(
          `[SessionManager] Session ${sessionId} already ${sessionStateAfterHandshake} after handshake - skipping adapter readiness wait`
        );
      }

      // Re-fetch session to get the most up-to-date state
      const finalSession = this._getSessionById(sessionId);
      const finalState = finalSession.state;

      this.logger.info(
        `[SessionManager] Debugging started for session ${sessionId}. State: ${finalState}`
      );

      return {
        success: true,
        state: finalState,
        data: {
          message: `Debugging started for ${scriptPath}. Current state: ${finalState}`,
          reason:
            finalState === SessionState.PAUSED
              ? dapLaunchArgs?.stopOnEntry
                ? 'entry'
                : 'breakpoint'
              : undefined,
          stopOnEntrySuccessful: !!dapLaunchArgs?.stopOnEntry && finalState === SessionState.PAUSED,
        },
      };
    } catch (error) {
      // Attempt to capture proxy log tail for debugging initialization failures
      let proxyLogTail: string | undefined;
      let proxyLogPath: string | undefined;
      try {
        const latestSession = this._getSessionById(sessionId);
        if (latestSession.logDir) {
          proxyLogPath = path.join(latestSession.logDir, `proxy-${sessionId}.log`);
          const logExists = await this.fileSystem.pathExists(proxyLogPath);
          if (logExists) {
            const logContent = await this.fileSystem.readFile(proxyLogPath, 'utf-8');
            const logLines = logContent.split(/\r?\n/);
            const tailLineCount = 80;
            const startIndex = Math.max(0, logLines.length - tailLineCount);
            proxyLogTail = logLines.slice(startIndex).join('\n');
          }
        }
      } catch (logReadError) {
        proxyLogTail = `<<Failed to read proxy log: ${logReadError instanceof Error ? logReadError.message : String(logReadError)
          }>>`;
      }

      // Comprehensive error capture for debugging Windows CI issues
      const errorDetails: Record<string, unknown> = {
        type: error?.constructor?.name || 'Unknown',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : 'No stack available',
        code: (error as Record<string, unknown>)?.code,
        errno: (error as Record<string, unknown>)?.errno,
        syscall: (error as Record<string, unknown>)?.syscall,
        path: (error as Record<string, unknown>)?.path,
        toString: error?.toString ? error.toString() : 'No toString',
        proxyLogPath,
        proxyLogTail
      };

      // Try to capture raw error object
      try {
        errorDetails.raw = JSON.stringify(error);
      } catch {
        errorDetails.raw = 'Error not JSON serializable';
      }

      // Log comprehensive error details
      this.logger.error(
        `[SessionManager] Detailed error in startDebugging for session ${sessionId}:`,
        errorDetails
      );

      // Also log to console for CI visibility
      if (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') {
        console.error('[SessionManager] Windows CI Debug - Full error details:', errorDetails);
      }

      const errorMessage = error instanceof Error ? error.message : String(error);

      const toolchainValidation =
        (error as { toolchainValidation?: ToolchainValidationState })?.toolchainValidation ??
        session.toolchainValidation;
      const incompatibleToolchain =
        Boolean(toolchainValidation) && toolchainValidation?.compatible === false;

      if (incompatibleToolchain) {
        this._updateSessionState(session, SessionState.CREATED);
        this.sessionStore.update(sessionId, {
          sessionLifecycle: SessionLifecycleState.CREATED,
        });
      } else {
        this._updateSessionState(session, SessionState.ERROR);
      }

      if (session.proxyManager) {
        await session.proxyManager.stop();
        session.proxyManager = undefined;
      }

      // Normalize error identity for callers/tests
      let errorType: string | undefined;
      let errorCode: number | undefined;
      if (error instanceof McpError) {
        errorType = (error as McpError).constructor.name || 'McpError';
        errorCode = (error as McpError).code as number | undefined;
      } else if (error instanceof Error) {
        errorType = error.constructor.name || 'Error';
      }

      if (incompatibleToolchain && toolchainValidation) {
        const behavior = (toolchainValidation.behavior ?? 'warn').toLowerCase();
        const canContinue = behavior !== 'error';
        const updatedSession = this._getSessionById(sessionId);
        return {
          success: false,
          error: 'MSVC_TOOLCHAIN_DETECTED',
          state: updatedSession.state,
          data: {
            message: toolchainValidation.message ?? errorMessage,
            toolchainValidation,
          },
          canContinue,
          errorType,
          errorCode,
        };
      }

      return { success: false, error: errorMessage, state: session.state, errorType, errorCode };
    }
  }


  async setBreakpoint(
    sessionId: string,
    file: string,
    line: number,
    condition?: string
  ): Promise<Breakpoint> {
    const session = this._getSessionById(sessionId);

    // Check if session is terminated
    if (session.sessionLifecycle === SessionLifecycleState.TERMINATED) {
      throw new SessionTerminatedError(sessionId);
    }

    const bpId = uuidv4();

    // The file path has been validated and translated by server.ts before reaching here
    this.logger.info(
      `[SessionManager setBreakpoint] Using validated file path "${file}" for session ${sessionId}`
    );

    const newBreakpoint: Breakpoint = { id: bpId, file, line, condition, verified: false };

    if (!session.breakpoints) session.breakpoints = new Map();
    session.breakpoints.set(bpId, newBreakpoint);
    this.logger.info(
      `[SessionManager] Breakpoint ${bpId} queued for ${file}:${line} in session ${sessionId}.`
    );

    if (
      session.proxyManager &&
      session.proxyManager.isRunning() &&
      (session.state === SessionState.RUNNING || session.state === SessionState.PAUSED)
    ) {
      try {
        this.logger.info(
          `[SessionManager] Active proxy for session ${sessionId}, sending breakpoint ${bpId}.`
        );
        const response =
          await session.proxyManager.sendDapRequest<DebugProtocol.SetBreakpointsResponse>(
            'setBreakpoints',
            {
              source: { path: newBreakpoint.file },
              breakpoints: [{ line: newBreakpoint.line, condition: newBreakpoint.condition }],
            }
          );
        if (
          response &&
          response.body &&
          response.body.breakpoints &&
          response.body.breakpoints.length > 0
        ) {
          const bpInfo = response.body.breakpoints[0];
          newBreakpoint.verified = bpInfo.verified;
          newBreakpoint.line = bpInfo.line || newBreakpoint.line;
          newBreakpoint.message = bpInfo.message; // Capture validation message

          // Determine condition verification status
          // If a condition was provided, check if the adapter accepted it
          if (newBreakpoint.condition) {
            // If breakpoint is verified, we assume condition is syntactically valid
            // (actual runtime evaluation may still fail for undefined variables)
            if (bpInfo.verified) {
              newBreakpoint.conditionVerified = true;
            } else {
              // If not verified and there's a message, it's likely a condition error
              // Common messages: "Unbound breakpoint" (js-debug), condition syntax errors
              newBreakpoint.conditionVerified = false;
              if (bpInfo.message) {
                newBreakpoint.conditionError = bpInfo.message;
              }
            }
          }

          this.logger.info(
            `[SessionManager] Breakpoint ${bpId} sent and response received. Verified: ${newBreakpoint.verified}` +
            `${bpInfo.message ? `, Message: ${bpInfo.message}` : ''}` +
            `${newBreakpoint.condition ? `, ConditionVerified: ${newBreakpoint.conditionVerified}` : ''}`
          );

          // Log breakpoint verification with structured logging
          if (newBreakpoint.verified) {
            this.logger.info('debug:breakpoint', {
              event: 'verified',
              sessionId: sessionId,
              sessionName: session.name,
              breakpointId: bpId,
              file: newBreakpoint.file,
              line: newBreakpoint.line,
              verified: true,
              condition: newBreakpoint.condition,
              conditionVerified: newBreakpoint.conditionVerified,
              timestamp: Date.now(),
            });
          }
        }
      } catch (error) {
        this.logger.error(
          `[SessionManager] Error sending setBreakpoint to proxy for session ${sessionId}:`,
          error
        );
      }
    }
    return newBreakpoint;
  }

  async stepOver(sessionId: string): Promise<DebugResult> {
    const session = this._getSessionById(sessionId);

    // Check if session is terminated
    if (session.sessionLifecycle === SessionLifecycleState.TERMINATED) {
      throw new SessionTerminatedError(sessionId);
    }

    const threadId = session.proxyManager?.getCurrentThreadId();
    this.logger.info(
      `[SM stepOver ${sessionId}] Entered. Current state: ${session.state}, ThreadID: ${threadId}`
    );

    if (!session.proxyManager || !session.proxyManager.isRunning()) {
      throw new ProxyNotRunningError(sessionId, 'step over');
    }
    if (session.state !== SessionState.PAUSED) {
      this.logger.warn(`[SM stepOver ${sessionId}] Not paused. State: ${session.state}`);
      return { success: false, error: 'Not paused', state: session.state };
    }
    if (typeof threadId !== 'number') {
      this.logger.warn(`[SM stepOver ${sessionId}] No current thread ID.`);
      return { success: false, error: 'No current thread ID', state: session.state };
    }

    this.logger.info(`[SM stepOver ${sessionId}] Sending DAP 'next' for threadId ${threadId}`);

    try {
      return await this._executeStepOperation(session, sessionId, {
        command: 'next',
        threadId,
        logTag: 'stepOver',
        successMessage: 'Step completed.',
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`[SM stepOver ${sessionId}] Error during step:`, error);
      this._updateSessionState(session, SessionState.ERROR);
      return { success: false, error: errorMessage, state: session.state };
    }
  }

  async stepInto(sessionId: string): Promise<DebugResult> {
    const session = this._getSessionById(sessionId);

    // Check if session is terminated
    if (session.sessionLifecycle === SessionLifecycleState.TERMINATED) {
      throw new SessionTerminatedError(sessionId);
    }

    const threadId = session.proxyManager?.getCurrentThreadId();
    this.logger.info(
      `[SM stepInto ${sessionId}] Entered. Current state: ${session.state}, ThreadID: ${threadId}`
    );

    if (!session.proxyManager || !session.proxyManager.isRunning()) {
      throw new ProxyNotRunningError(sessionId, 'step into');
    }
    if (session.state !== SessionState.PAUSED) {
      this.logger.warn(`[SM stepInto ${sessionId}] Not paused. State: ${session.state}`);
      return { success: false, error: 'Not paused', state: session.state };
    }
    if (typeof threadId !== 'number') {
      this.logger.warn(`[SM stepInto ${sessionId}] No current thread ID.`);
      return { success: false, error: 'No current thread ID', state: session.state };
    }

    this.logger.info(`[SM stepInto ${sessionId}] Sending DAP 'stepIn' for threadId ${threadId}`);

    try {
      return await this._executeStepOperation(session, sessionId, {
        command: 'stepIn',
        threadId,
        logTag: 'stepInto',
        successMessage: 'Step into completed.',
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`[SM stepInto ${sessionId}] Error during step:`, error);
      this._updateSessionState(session, SessionState.ERROR);
      return { success: false, error: errorMessage, state: session.state };
    }
  }

  async stepOut(sessionId: string): Promise<DebugResult> {
    const session = this._getSessionById(sessionId);

    // Check if session is terminated
    if (session.sessionLifecycle === SessionLifecycleState.TERMINATED) {
      throw new SessionTerminatedError(sessionId);
    }

    const threadId = session.proxyManager?.getCurrentThreadId();
    this.logger.info(
      `[SM stepOut ${sessionId}] Entered. Current state: ${session.state}, ThreadID: ${threadId}`
    );

    if (!session.proxyManager || !session.proxyManager.isRunning()) {
      throw new ProxyNotRunningError(sessionId, 'step out');
    }
    if (session.state !== SessionState.PAUSED) {
      this.logger.warn(`[SM stepOut ${sessionId}] Not paused. State: ${session.state}`);
      return { success: false, error: 'Not paused', state: session.state };
    }
    if (typeof threadId !== 'number') {
      this.logger.warn(`[SM stepOut ${sessionId}] No current thread ID.`);
      return { success: false, error: 'No current thread ID', state: session.state };
    }

    this.logger.info(`[SM stepOut ${sessionId}] Sending DAP 'stepOut' for threadId ${threadId}`);

    try {
      return await this._executeStepOperation(session, sessionId, {
        command: 'stepOut',
        threadId,
        logTag: 'stepOut',
        successMessage: 'Step out completed.',
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`[SM stepOut ${sessionId}] Error during step:`, error);
      this._updateSessionState(session, SessionState.ERROR);
      return { success: false, error: errorMessage, state: session.state };
    }
  }

  private _executeStepOperation(
    session: ManagedSession,
    sessionId: string,
    options: {
      command: 'next' | 'stepIn' | 'stepOut';
      threadId: number;
      logTag: string;
      successMessage: string;
      terminatedMessage?: string;
      exitedMessage?: string;
    }
  ): Promise<DebugResult> {
    const proxyManager = session.proxyManager;

    if (!proxyManager) {
      return Promise.resolve({
        success: false,
        error: 'Proxy manager unavailable',
        state: session.state,
      });
    }

    const terminatedMessage =
      options.terminatedMessage ?? 'Step completed as session terminated.';
    const exitedMessage = options.exitedMessage ?? 'Step completed as session exited.';

    return new Promise((resolve) => {
      let settled = false;

      const cleanup = () => {
        proxyManager.off('stopped', onStopped);
        proxyManager.off('terminated', onTerminated);
        proxyManager.off('exited', onExited);
        proxyManager.off('exit', onExit);
        clearTimeout(timeout);
      };

      const settle = (result: DebugResult) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(result);
      };

      const success = (message: string, location?: { file: string; line: number; column?: number }) => {
        this.logger.info(`[SM ${options.logTag} ${sessionId}] ${message} Current state: ${session.state}`);
        const data: { message: string; location?: { file: string; line: number; column?: number } } = { message };
        if (location) {
          data.location = location;
        }
        settle({
          success: true,
          state: session.state,
          data,
        });
      };

      const onStopped = async () => {
        // Try to get current location from stack trace
        let location: { file: string; line: number; column?: number } | undefined;
        try {
          // Wait a brief moment for state to settle after stopped event
          await new Promise(resolve => setTimeout(resolve, 10));

          const stackFrames = await this.getStackTrace(sessionId);
          if (stackFrames && stackFrames.length > 0) {
            const topFrame = stackFrames[0];
            location = {
              file: topFrame.file,
              line: topFrame.line,
              column: topFrame.column
            };
            this.logger.debug(`[SM ${options.logTag} ${sessionId}] Captured location: ${location.file}:${location.line}`);
          }
        } catch (error) {
          // Log but don't fail the step operation if we can't get location
          this.logger.debug(`[SM ${options.logTag} ${sessionId}] Could not capture location:`, error);
        }
        success(options.successMessage, location);
      };

      const onTerminated = () => success(terminatedMessage);
      const onExited = () => success(exitedMessage);
      const onExit = () => success(exitedMessage);

      const timeout = setTimeout(() => {
        this.logger.warn(
          `[SM ${options.logTag} ${sessionId}] Timeout waiting for stopped or termination event`
        );
        settle({
          success: false,
          error: ErrorMessages.stepTimeout(5),
          state: session.state,
        });
      }, 5000);

      proxyManager.on('stopped', onStopped);
      proxyManager.on('terminated', onTerminated);
      proxyManager.on('exited', onExited);
      proxyManager.on('exit', onExit);

      this._updateSessionState(session, SessionState.RUNNING);

      proxyManager
        .sendDapRequest(options.command, { threadId: options.threadId })
        .catch((error: unknown) => {
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.logger.error(
            `[SM ${options.logTag} ${sessionId}] Error during step request:`,
            error
          );
          this._updateSessionState(session, SessionState.ERROR);
          settle({ success: false, error: errorMessage, state: session.state });
        });
    });
  }

  async pause(sessionId: string): Promise<DebugResult> {
    const session = this._getSessionById(sessionId);

    // Check if session is terminated
    if (session.sessionLifecycle === SessionLifecycleState.TERMINATED) {
      throw new SessionTerminatedError(sessionId);
    }

    this.logger.info(
      `[SessionManager pause] Called for session ${sessionId}. Current state: ${session.state}`
    );

    if (!session.proxyManager || !session.proxyManager.isRunning()) {
      throw new ProxyNotRunningError(sessionId, 'pause');
    }

    // If already paused, we can just return success
    if (session.state === SessionState.PAUSED || session.state === SessionState.STOPPED) {
      this.logger.info(`[SessionManager pause] Session ${sessionId} is already paused.`);
      return { success: true, state: session.state };
    }

    let threadId = session.proxyManager.getCurrentThreadId();

    if (typeof threadId !== 'number') {
      try {
        this.logger.info(`[SessionManager pause] No current thread ID. Attempting to fetch threads...`);
        const threadsResponse = await session.proxyManager.sendDapRequest<DebugProtocol.ThreadsResponse>('threads', {});
        if (threadsResponse.body && threadsResponse.body.threads && threadsResponse.body.threads.length > 0) {
          threadId = threadsResponse.body.threads[0].id;
          this.logger.info(`[SessionManager pause] Retrieved thread ID ${threadId} from threads request.`);
        } else {
          this.logger.warn(`[SessionManager pause] Could not retrieve threads. Defaulting to 1.`);
          threadId = 1;
        }
      } catch (e) {
        this.logger.warn(`[SessionManager pause] Failed to get threads: ${e}. Defaulting to 1.`);
        threadId = 1;
      }
    }

    try {
      this.logger.info(
        `[SessionManager pause] Sending DAP 'pause' for session ${sessionId}, threadId ${threadId}.`
      );
      await session.proxyManager.sendDapRequest('pause', { threadId });

      // We don't update state to PAUSED here immediately.
      // We wait for the 'stopped' event from the adapter to update the state.
      // However, we can return success that the request was sent.

      return { success: true, state: session.state };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `[SessionManager pause] Error sending 'pause' to proxy for session ${sessionId}: ${errorMessage}`
      );
      throw error;
    }
  }


  async continue(sessionId: string): Promise<DebugResult> {
    const session = this._getSessionById(sessionId);

    // Check if session is terminated
    if (session.sessionLifecycle === SessionLifecycleState.TERMINATED) {
      throw new SessionTerminatedError(sessionId);
    }

    const threadId = session.proxyManager?.getCurrentThreadId();
    this.logger.info(
      `[SessionManager continue] Called for session ${sessionId}. Current state: ${session.state}, ThreadID: ${threadId}`
    );

    if (!session.proxyManager || !session.proxyManager.isRunning()) {
      throw new ProxyNotRunningError(sessionId, 'continue');
    }
    if (session.state !== SessionState.PAUSED) {
      this.logger.warn(
        `[SessionManager continue] Session ${sessionId} not paused. State: ${session.state}.`
      );
      return { success: false, error: 'Not paused', state: session.state };
    }
    if (typeof threadId !== 'number') {
      this.logger.warn(
        `[SessionManager continue] No current thread ID for session ${sessionId}.`
      );
      return { success: false, error: 'No current thread ID', state: session.state };
    }

    try {
      this.logger.info(
        `[SessionManager continue] Sending DAP 'continue' for session ${sessionId}, threadId ${threadId}.`
      );
      await session.proxyManager.sendDapRequest('continue', { threadId });

      if (session.state === SessionState.PAUSED || session.state === SessionState.STOPPED) {
        this.logger.debug(
          `[SessionManager continue] DAP 'continue' completed but session ${sessionId} is already ${session.state}; skipping RUNNING update.`
        );
      } else {
        this._updateSessionState(session, SessionState.RUNNING);
        this.logger.info(
          `[SessionManager continue] DAP 'continue' sent, session ${sessionId} state updated to RUNNING.`
        );
      }
      return { success: true, state: session.state };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `[SessionManager continue] Error sending 'continue' to proxy for session ${sessionId}: ${errorMessage}`
      );
      throw error;
    }
  }


  /**
   * Helper method to truncate long strings for logging
   */
  private truncateForLog(value: string, maxLength: number = 1000): string {
    if (!value) return '';
    return value.length > maxLength ? value.substring(0, maxLength) + '... (truncated)' : value;
  }

  /**
   * Truncate a value string for preview display
   */
  private truncateValue(value: string, maxLength: number = PREVIEW_MAX_STRING_LENGTH): string {
    if (!value) return '';
    if (value.length <= maxLength) return value;
    return `${value.substring(0, maxLength)}... (${value.length} chars)`;
  }

  /**
   * Build a rich preview string for a complex object by expanding its properties
   */
  private async buildObjectPreview(
    sessionId: string,
    variablesReference: number,
    rawResult: string,
    type?: string,
    namedVariables?: number,
    indexedVariables?: number
  ): Promise<string> {
    // If no children to expand, return the raw result (possibly truncated)
    if (variablesReference <= 0) {
      return this.truncateValue(rawResult, PREVIEW_MAX_STRING_LENGTH);
    }

    const session = this._getSessionById(sessionId);
    if (!session.proxyManager || !session.proxyManager.isRunning()) {
      return this.truncateValue(rawResult, PREVIEW_MAX_STRING_LENGTH);
    }

    try {
      // Fetch child variables
      const response = await session.proxyManager.sendDapRequest<DebugProtocol.VariablesResponse>(
        'variables',
        { variablesReference }
      );

      if (!response?.body?.variables || response.body.variables.length === 0) {
        return this.truncateValue(rawResult, PREVIEW_MAX_STRING_LENGTH);
      }

      const variables = response.body.variables;
      const totalCount = variables.length;
      const isArray = this.looksLikeArray(type, rawResult, variables);

      if (isArray) {
        return this.buildArrayPreview(variables, totalCount, indexedVariables);
      } else {
        return this.buildDictPreview(variables, totalCount, namedVariables);
      }
    } catch (error) {
      this.logger.debug(`[buildObjectPreview] Failed to expand: ${error}`);
      return this.truncateValue(rawResult, PREVIEW_MAX_STRING_LENGTH);
    }
  }

  /**
   * Determine if a result looks like an array/list based on type and structure
   */
  private looksLikeArray(
    type?: string,
    rawResult?: string,
    variables?: DebugProtocol.Variable[]
  ): boolean {
    // Check type hints
    if (type) {
      const lowerType = type.toLowerCase();
      if (lowerType.includes('list') || lowerType.includes('array') ||
          lowerType.includes('tuple') || lowerType.includes('set') ||
          lowerType === '[]' || lowerType.match(/^\[.*\]$/)) {
        return true;
      }
    }

    // Check if raw result looks like array
    if (rawResult && (rawResult.startsWith('[') || rawResult.startsWith('('))) {
      return true;
    }

    // Check if all variable names are numeric indices
    if (variables && variables.length > 0) {
      const allNumeric = variables.every(v => /^\d+$/.test(v.name));
      if (allNumeric) return true;
    }

    return false;
  }

  /**
   * Build preview for array-like structures
   */
  private buildArrayPreview(
    variables: DebugProtocol.Variable[],
    fetchedCount: number,
    totalIndexed?: number
  ): string {
    const previewItems: string[] = [];
    const limit = Math.min(PREVIEW_MAX_ARRAY_ITEMS, variables.length);

    for (let i = 0; i < limit; i++) {
      const v = variables[i];
      const valuePreview = this.truncateValue(v.value, 50);
      previewItems.push(valuePreview);
    }

    const totalCount = totalIndexed ?? fetchedCount;
    const remaining = totalCount - limit;

    if (remaining > 0) {
      return `[${previewItems.join(', ')}, ... (${totalCount} total)]`;
    } else {
      return `[${previewItems.join(', ')}]`;
    }
  }

  /**
   * Build preview for object/dict-like structures
   */
  private buildDictPreview(
    variables: DebugProtocol.Variable[],
    fetchedCount: number,
    totalNamed?: number
  ): string {
    const previewItems: string[] = [];
    const limit = Math.min(PREVIEW_MAX_PROPERTIES, variables.length);

    // Filter out special/internal properties for cleaner preview
    const userVariables = variables.filter(v => !this.isInternalProperty(v.name));
    const displayVars = userVariables.length > 0 ? userVariables : variables;
    const actualLimit = Math.min(limit, displayVars.length);

    for (let i = 0; i < actualLimit; i++) {
      const v = displayVars[i];
      const valuePreview = this.truncateValue(v.value, 50);

      // Format based on whether it has children
      if (v.variablesReference > 0) {
        // Has children - show type hint
        const typeHint = v.type ? ` (${v.type})` : '';
        previewItems.push(`${v.name}: {...}${typeHint}`);
      } else {
        previewItems.push(`${v.name}: ${valuePreview}`);
      }
    }

    const totalCount = totalNamed ?? fetchedCount;
    const remaining = totalCount - actualLimit;

    let preview = `{ ${previewItems.join(', ')}`;
    if (remaining > 0) {
      preview += `, ... (${remaining} more)`;
    }
    preview += ' }';

    // Final length check
    if (preview.length > PREVIEW_MAX_TOTAL_LENGTH) {
      return preview.substring(0, PREVIEW_MAX_TOTAL_LENGTH - 20) + '... (truncated) }';
    }

    return preview;
  }

  /**
   * Check if a property name looks like an internal/special property
   */
  private isInternalProperty(name: string): boolean {
    // Python internals
    if (name.startsWith('__') && name.endsWith('__')) return true;
    // JavaScript internals
    if (name === '__proto__' || name === 'constructor') return true;
    // Common internal prefixes
    if (name.startsWith('_') && name.length > 1) return true;
    return false;
  }

  /**
   * Parse an error message and return structured error information with suggestions
   */
  private parseEvaluationError(errorMessage: string, expression: string): EvaluateErrorInfo {
    const originalError = errorMessage;

    // SyntaxError patterns (Python, JavaScript, and others)
    if (errorMessage.includes('SyntaxError') || errorMessage.includes('Unexpected token')) {
      const suggestion = this.getSyntaxErrorSuggestion(errorMessage, expression);
      return {
        category: 'SyntaxError',
        message: 'Invalid syntax in expression',
        suggestion,
        originalError
      };
    }

    // ReferenceError patterns (JavaScript) - must check before NameError since it also contains "is not defined"
    if (errorMessage.includes('ReferenceError')) {
      const match = errorMessage.match(/ReferenceError:\s*(\w+)\s+is not defined/i);
      const varName = match ? match[1] : null;
      return {
        category: 'ReferenceError',
        message: varName ? `Variable '${varName}' is not defined` : 'Reference error',
        suggestion: varName
          ? `Check spelling of '${varName}'. Use get_local_variables to see available variables in scope.`
          : 'Use get_local_variables to see available variables in the current scope.',
        originalError
      };
    }

    // NameError patterns (Python) - also catches generic "is not defined" from other adapters
    if (errorMessage.includes('NameError') || errorMessage.includes('is not defined')) {
      const match = errorMessage.match(/name ['\"]?(\w+)['\"]? is not defined/i) ||
                    errorMessage.match(/['\"]?(\w+)['\"]? is not defined/i);
      const varName = match ? match[1] : null;
      return {
        category: 'NameError',
        message: varName ? `Variable '${varName}' is not defined` : 'Name not found',
        suggestion: varName
          ? `Check spelling of '${varName}'. Use get_local_variables to see available variables in scope.`
          : 'Use get_local_variables to see available variables in the current scope.',
        originalError
      };
    }

    // TypeError patterns (Python and JavaScript)
    if (errorMessage.includes('TypeError')) {
      return {
        category: 'TypeError',
        message: 'Type mismatch in expression',
        suggestion: 'Check that operands are compatible types and the operation is valid for the given types.',
        originalError
      };
    }

    // AttributeError patterns (Python) and property access errors (JavaScript)
    if (errorMessage.includes('AttributeError') || errorMessage.includes('has no attribute') ||
        errorMessage.includes('Cannot read property') || errorMessage.includes('undefined is not an object')) {
      const match = errorMessage.match(/has no attribute ['\"]?(\w+)['\"]?/i) ||
                    errorMessage.match(/Cannot read property ['\"]?(\w+)['\"]?/i);
      const attrName = match ? match[1] : null;
      return {
        category: 'AttributeError',
        message: attrName ? `Property '${attrName}' not found` : 'Property or attribute not found',
        suggestion: attrName
          ? `Object does not have property '${attrName}'. Check the object structure with get_local_variables.`
          : 'Use get_local_variables to inspect the object structure.',
        originalError
      };
    }

    // RangeError patterns (JavaScript) - similar to IndexError
    if (errorMessage.includes('RangeError')) {
      return {
        category: 'RangeError',
        message: 'Value out of range',
        suggestion: 'Check array bounds or numeric limits before the operation.',
        originalError
      };
    }

    // IndexError patterns (Python)
    if (errorMessage.includes('IndexError') || errorMessage.includes('index out of range')) {
      return {
        category: 'IndexError',
        message: 'Index out of range',
        suggestion: 'Check the length of the sequence before accessing by index.',
        originalError
      };
    }

    // KeyError patterns
    if (errorMessage.includes('KeyError')) {
      const match = errorMessage.match(/KeyError:?\s*['\"]?([^'\"]+)['\"]?/i);
      const keyName = match ? match[1] : null;
      return {
        category: 'KeyError',
        message: keyName ? `Key '${keyName}' not found` : 'Key not found in dictionary',
        suggestion: 'Use .keys() or .get(key, default) to safely access dictionary keys.',
        originalError
      };
    }

    // ValueError patterns
    if (errorMessage.includes('ValueError')) {
      return {
        category: 'ValueError',
        message: 'Invalid value',
        suggestion: 'Check that the value is appropriate for the operation.',
        originalError
      };
    }

    // RuntimeError patterns
    if (errorMessage.includes('RuntimeError')) {
      return {
        category: 'RuntimeError',
        message: 'Runtime error during evaluation',
        suggestion: 'The expression caused a runtime error. Check for recursion limits or invalid operations.',
        originalError
      };
    }

    // LLDB-specific error patterns (used by Zig, Rust/CodeLLDB)
    if (errorMessage.includes('undeclared identifier') || errorMessage.includes('use of undeclared identifier')) {
      const match = errorMessage.match(/identifier\s+['\"]?(\w+)['\"]?/i);
      const varName = match ? match[1] : null;
      return {
        category: 'UndeclaredIdentifier',
        message: varName ? `Variable '${varName}' is not declared` : 'Undeclared identifier',
        suggestion: varName
          ? `Check spelling of '${varName}'. Use get_local_variables to see available variables in scope.`
          : 'Use get_local_variables to see available variables in the current scope.',
        originalError
      };
    }

    // LLDB "no member" errors (struct/object member access)
    if (errorMessage.includes('no member named') || errorMessage.includes('has no member')) {
      const match = errorMessage.match(/member\s+(?:named\s+)?['\"]?(\w+)['\"]?/i);
      const memberName = match ? match[1] : null;
      return {
        category: 'NoMember',
        message: memberName ? `Member '${memberName}' not found` : 'Member not found',
        suggestion: memberName
          ? `Object does not have member '${memberName}'. Use get_local_variables to inspect the object structure.`
          : 'Use get_local_variables to inspect the object structure.',
        originalError
      };
    }

    // LLDB expression parsing errors
    if (errorMessage.includes('expression failed to parse') || errorMessage.includes("couldn't execute expression")) {
      return {
        category: 'ExpressionParseError',
        message: 'Expression could not be parsed',
        suggestion: 'Check expression syntax for the target language. LLDB may not support all language constructs.',
        originalError
      };
    }

    // LLDB generic errors (often prefixed with "error:")
    if (errorMessage.toLowerCase().startsWith('error:')) {
      return {
        category: 'LLDBError',
        message: 'LLDB evaluation error',
        suggestion: 'Expression evaluation failed. This may be a limitation of the debugger expression evaluator.',
        originalError
      };
    }

    // Unknown error
    return {
      category: 'Unknown',
      message: 'Expression evaluation failed',
      suggestion: 'Check the expression syntax and ensure all referenced variables are in scope.',
      originalError
    };
  }

  /**
   * Generate helpful suggestions for syntax errors
   */
  private getSyntaxErrorSuggestion(errorMessage: string, expression: string): string {
    // Unclosed parenthesis/bracket
    const openParens = (expression.match(/\(/g) || []).length;
    const closeParens = (expression.match(/\)/g) || []).length;
    if (openParens !== closeParens) {
      return `Mismatched parentheses: ${openParens} opening, ${closeParens} closing.`;
    }

    const openBrackets = (expression.match(/\[/g) || []).length;
    const closeBrackets = (expression.match(/\]/g) || []).length;
    if (openBrackets !== closeBrackets) {
      return `Mismatched brackets: ${openBrackets} opening, ${closeBrackets} closing.`;
    }

    // Unclosed string
    const singleQuotes = (expression.match(/'/g) || []).length;
    const doubleQuotes = (expression.match(/"/g) || []).length;
    if (singleQuotes % 2 !== 0) {
      return 'Unclosed single-quoted string.';
    }
    if (doubleQuotes % 2 !== 0) {
      return 'Unclosed double-quoted string.';
    }

    // Common typos
    if (expression.includes('==') && errorMessage.includes('invalid syntax')) {
      return 'If comparing values, ensure proper spacing around operators.';
    }

    return 'Check expression syntax. Ensure all parentheses, brackets, and quotes are balanced.';
  }

  /**
   * Evaluate an expression in the context of the current debug session.
   * The debugger must be paused for evaluation to work.
   * Expressions CAN and SHOULD be able to modify program state (this is a feature).
   *
   * @param sessionId - The session ID
   * @param expression - The expression to evaluate
   * @param frameId - Optional stack frame ID for context (defaults to current frame)
   * @param context - The context in which to evaluate ('repl' is default for maximum flexibility)
   * @returns Evaluation result with value, type, and optional variable reference
   */
  async evaluateExpression(
    sessionId: string,
    expression: string,
    frameId?: number,
    context: 'watch' | 'repl' | 'hover' | 'clipboard' | 'variables' = 'variables'
  ): Promise<EvaluateResult> {
    const session = this._getSessionById(sessionId);
    this.logger.info(
      `[SM evaluateExpression ${sessionId}] Entered. Expression: "${this.truncateForLog(
        expression,
        100
      )}", frameId: ${frameId}, context: ${context}, state: ${session.state}`
    );

    // Basic sanity checks
    if (!expression || expression.trim().length === 0) {
      this.logger.warn(`[SM evaluateExpression ${sessionId}] Empty expression provided`);
      return { success: false, error: 'Expression cannot be empty' };
    }

    // Validate session state
    if (!session.proxyManager || !session.proxyManager.isRunning()) {
      this.logger.warn(`[SM evaluateExpression ${sessionId}] No active proxy or proxy not running`);
      return { success: false, error: 'No active debug session' };
    }

    if (session.state !== SessionState.PAUSED) {
      this.logger.warn(
        `[SM evaluateExpression ${sessionId}] Cannot evaluate: session not paused. State: ${session.state}`
      );
      return {
        success: false,
        error: 'Cannot evaluate: debugger not paused. Ensure the debugger is stopped at a breakpoint.',
      };
    }

    // Handle frameId - get current frame from stack trace if not provided
    if (frameId === undefined) {
      try {
        const threadId = session.proxyManager.getCurrentThreadId();
        if (typeof threadId !== 'number') {
          this.logger.warn(
            `[SM evaluateExpression ${sessionId}] No current thread ID to get stack trace`
          );
          return {
            success: false,
            error: 'Unable to find thread for evaluation. Ensure the debugger is paused at a breakpoint.',
          };
        }

        this.logger.info(
          `[SM evaluateExpression ${sessionId}] No frameId provided, getting current frame from stack trace`
        );
        const stackResponse = await session.proxyManager.sendDapRequest<DebugProtocol.StackTraceResponse>(
          'stackTrace',
          {
            threadId,
            startFrame: 0,
            levels: 1, // We only need the first frame
          }
        );

        if (stackResponse?.body?.stackFrames && stackResponse.body.stackFrames.length > 0) {
          frameId = stackResponse.body.stackFrames[0].id;
          this.logger.info(
            `[SM evaluateExpression ${sessionId}] Using current frame ID: ${frameId} from stack trace`
          );
        } else {
          this.logger.warn(`[SM evaluateExpression ${sessionId}] No stack frames available`);
          return {
            success: false,
            error: 'No active stack frame. Ensure the debugger is paused at a breakpoint.',
          };
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `[SM evaluateExpression ${sessionId}] Error getting stack trace for default frame:`,
          error
        );
        return { success: false, error: `Unable to determine current frame: ${errorMessage}` };
      }
    }

    try {
      // Send DAP evaluate request
      this.logger.info(
        `[SM evaluateExpression ${sessionId}] Sending DAP 'evaluate' request. Expression: "${this.truncateForLog(
          expression,
          100
        )}", frameId: ${frameId}, context: ${context}`
      );

      const response =
        await session.proxyManager.sendDapRequest<DebugProtocol.EvaluateResponse>('evaluate', {
          expression,
          frameId,
          context,
        });

      // Log raw response in debug mode
      this.logger.debug(`[SM evaluateExpression ${sessionId}] DAP evaluate raw response:`, response);

      // Process response
      if (response && response.body) {
        const body = response.body;
        const rawResult = body.result || '';
        const variablesReference = body.variablesReference || 0;

        // Build rich preview for complex objects
        const preview = await this.buildObjectPreview(
          sessionId,
          variablesReference,
          rawResult,
          body.type,
          body.namedVariables,
          body.indexedVariables
        );

        const result: EvaluateResult = {
          success: true,
          result: rawResult,
          type: body.type,
          preview,
          variablesReference,
          namedVariables: body.namedVariables,
          indexedVariables: body.indexedVariables,
          presentationHint: body.presentationHint,
        };

        // Log the evaluation result with structured logging
        this.logger.info('debug:evaluate', {
          event: 'expression',
          sessionId,
          sessionName: session.name,
          expression: this.truncateForLog(expression, 100),
          frameId,
          context,
          result: this.truncateForLog(rawResult, 1000),
          preview: this.truncateForLog(preview, 500),
          type: result.type,
          variablesReference: result.variablesReference,
          namedVariables: result.namedVariables,
          indexedVariables: result.indexedVariables,
          timestamp: Date.now(),
        });

        this.logger.info(
          `[SM evaluateExpression ${sessionId}] Evaluation successful. Preview: "${this.truncateForLog(
            preview,
            200
          )}", Type: ${result.type}, VarRef: ${result.variablesReference}`
        );

        return result;
      } else {
        this.logger.warn(`[SM evaluateExpression ${sessionId}] No body in evaluate response`);
        return { success: false, error: 'No response body from debug adapter' };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Parse error into structured format with suggestions
      const errorInfo = this.parseEvaluationError(errorMessage, expression);

      // Log the error with structured info
      this.logger.error('debug:evaluate', {
        event: 'error',
        sessionId,
        sessionName: session.name,
        expression: this.truncateForLog(expression, 100),
        frameId,
        context,
        errorCategory: errorInfo.category,
        errorMessage: errorInfo.message,
        suggestion: errorInfo.suggestion,
        originalError: errorMessage,
        timestamp: Date.now(),
      });

      this.logger.error(`[SM evaluateExpression ${sessionId}] Error evaluating expression:`, error);

      return {
        success: false,
        error: errorInfo.message,
        errorInfo
      };
    }
  }

  /**
   * Wait for a session to emit a stopped event after launch to honour the first breakpoint.
   */
  private async waitForInitialBreakpointPause(sessionId: string, timeoutMs: number): Promise<boolean> {
    const session = this._getSessionById(sessionId);
    const proxyManager = session.proxyManager;

    if (!proxyManager) {
      return false;
    }

    if (session.state === SessionState.PAUSED) {
      return true;
    }

    return new Promise<boolean>((resolve) => {
      let settled = false;

      const cleanup = () => {
        proxyManager.removeListener('stopped', onStopped);
        clearTimeout(timer);
      };

      const onStopped = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(true);
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(false);
      }, timeoutMs);

      proxyManager.once('stopped', onStopped);
    });
  }
}
