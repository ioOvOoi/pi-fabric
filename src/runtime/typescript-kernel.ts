import type { FabricExecutorRuntime } from "../config.js";
import type { FabricGuestTypeSources } from "../protocol.js";
import type { FabricKernelRuntime, FabricHostCall, FabricSandboxOptions } from "./kernel.js";
import { QuickJsRuntime } from "./quickjs-runtime.js";
import { BunProcessRuntime, NodeProcessRuntime } from "./node-process-runtime.js";
import { repairFabricGuestCode } from "./guest-code-repair.js";
import { typeCheckFabricCode, typeCheckGuestPrelude } from "./type-checker.js";
import { guestTypeDeclarations } from "./guest-types.js";
import { buildDynamicGuestDeclarations } from "./dynamic-guest-types.js";
import { buildCoreOverrideGuestDeclarations, type FabricCoreOverrideTypeSource } from "./core-override-guest-types.js";

// TypeScript is one kernel, with several JavaScript execution engines.
// Keep compiler and guest declaration dependencies behind this lazy boundary.
export class TypeScriptKernelRuntime implements FabricKernelRuntime {
  readonly #runtime: FabricKernelRuntime;

  constructor(runtime: FabricExecutorRuntime) {
    this.#runtime = runtime === "node-process"
      ? new NodeProcessRuntime()
      : runtime === "bun-process"
        ? new BunProcessRuntime()
        : new QuickJsRuntime();
  }

  prepare(
    source: string,
    fullCodeMode: boolean,
    unavailable: string[],
    sources: FabricGuestTypeSources,
    overrides: FabricCoreOverrideTypeSource[],
    // 宿主注入的 guest prelude（扩展生成的辅助代码）。它单独过一遍门禁（错误归它自己、行号只相对它），
    // 同时参与模型代码那次编译（否则模型看不见 prelude 声明的符号）。
    prelude?: string,
    includeTypeCorrectness = false,
  ) {
    const code = repairFabricGuestCode(source);
    const coreOverrides = fullCodeMode
      ? buildCoreOverrideGuestDeclarations(overrides)
      : undefined;
    const declarations = guestTypeDeclarations(fullCodeMode, {
      excludeGlobals: unavailable,
      dynamic: buildDynamicGuestDeclarations(sources),
      ...(coreOverrides ? { coreOverrides } : {}),
    });
    const checked = typeCheckFabricCode(code, declarations, includeTypeCorrectness, prelude);
    const preludeCheck = prelude ? typeCheckGuestPrelude(prelude, declarations) : undefined;
    return { code, checked, ...(preludeCheck ? { preludeCheck } : {}) };
  }

  execute(code: string, hostCall: FabricHostCall, options: FabricSandboxOptions) {
    return this.#runtime.execute(code, hostCall, options);
  }
}
