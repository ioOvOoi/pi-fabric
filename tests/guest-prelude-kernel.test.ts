import { describe, expect, it } from "vitest";
import { prepareFabricExecArguments } from "../src/fabric-exec-arguments.js";
import { TypeScriptKernelRuntime } from "../src/runtime/typescript-kernel.js";

// 宿主 prelude 通道的三条不变量：
//  1. prelude 的好坏不影响模型代码那份门禁结果；
//  2. prelude 的错误单独归因（行号相对 prelude 自己）；
//  3. 工具入参里的 prelude 能原样穿过参数准备阶段。
describe("fabric_exec 的宿主 prelude 通道", () => {
  const prepare = (prelude?: string) =>
    new TypeScriptKernelRuntime("quickjs").prepare(
      "return 1;",
      false,
      [],
      {},
      [],
      prelude,
    );

  it("没有 prelude 时行为与旧路径一致", () => {
    const { code, checked, preludeCheck } = prepare();
    expect(code).toBe("return 1;");
    expect(checked.errors).toEqual([]);
    expect(preludeCheck).toBeUndefined();
  });

  it("prelude 的类型错误单独归因，模型代码保持干净", () => {
    const { checked, preludeCheck } = prepare("const bad = notDefinedAnywhere;\n");
    expect(checked.errors).toEqual([]);
    expect(preludeCheck?.errors.length).toBeGreaterThan(0);
    expect(preludeCheck?.errors[0]?.line).toBe(1);
  });

  it("干净 prelude 给出可拼接的 emitted JS", () => {
    const { preludeCheck } = prepare("const helper = 1;\n");
    expect(preludeCheck?.errors).toEqual([]);
    expect(preludeCheck?.javascript).toContain("const helper = 1;");
  });

  it("prelude 穿过参数准备阶段，null 被清掉", () => {
    expect(
      prepareFabricExecArguments({ code: "return 1;", prelude: "const a = 1;\n" }, "typescript"),
    ).toMatchObject({ prelude: "const a = 1;\n" });
    expect(
      prepareFabricExecArguments({ code: "return 1;", prelude: null }, "typescript"),
    ).not.toHaveProperty("prelude");
  });
});
