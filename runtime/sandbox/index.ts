/**
 * Running commands somewhere other than this machine.
 *
 * The barrel. `registry.ts` holds the executor currently in use, `control.ts`
 * turns sandboxing on and off, and the rest is the E2B implementation behind
 * them. A tool only ever needs `currentExecutor` or `isSandboxed`.
 */

export type { Executor, ProcessHandle } from "./executor";
export { localExecutor } from "./localExecutor";
export {
  currentExecutor,
  isSandboxed,
  resetExecutor,
  setExecutor,
} from "./registry";
export {
  disableSandbox,
  enableSandbox,
  isSandboxEnabled,
  sandboxSession,
  type EnableOptions,
} from "./control";
export { createSandboxExecutor } from "./sandboxExecutor";
export {
  SandboxSession,
  SandboxUnavailableError,
  withToolchainPath,
  type CreateSandbox,
  type SandboxClient,
} from "./session";
export { createE2BSandbox, hasApiKey } from "./e2bClient";
export {
  forwardedEnv,
  isForwardableName,
  parseNetworkMode,
  resolveSandboxSettings,
  REMOTE_WORKSPACE,
  type NetworkMode,
  type SandboxSettings,
} from "./settings";
export {
  describeSkipped,
  isSecretShaped,
  transmittableSet,
  DEFAULT_MAX_FILE_BYTES,
  type TransmittableSet,
} from "./transmittable";
