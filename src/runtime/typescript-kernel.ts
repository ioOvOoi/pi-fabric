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
    // 宿主注入的 guest prelude（扩展生成的辅助代码）。它**不进**模型代码那份门禁：
    // 混在一起时 prelude 的错误会以模型代码的行号报出来，并把整条 fabric_exec 通道拒掉。
    prelude?: string,
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
    const checked = typeCheckFabricCode(code, declarations);
    const preludeCheck = prelude ? typeCheckGuestPrelude(prelude, declarations) : undefined;
    return { code, checked, ...(preludeCheck ? { preludeCheck } : {}) };
  }

  execute(code: string, hostCall: FabricHostCall, options: FabricSandboxOptions) {
    return this.#runtime.execute(code, hostCall, options);
  }
}
