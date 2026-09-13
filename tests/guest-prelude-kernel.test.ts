import { describe, expect, it } from "vitest";
import { prepareFabricExecArguments } from "../src/fabric-exec-arguments.js";
import { TypeScriptKernelRuntime } from "../src/runtime/typescript-kernel.js";

// 宿主 prelude 通道的三条不变量：
//  1. prelude 的好坏不影响模型代码那份门禁结果；
//  2. prelude 的错误单独归因（行号相对 prelude 自己）；
//  3. 工具入参里的 prelude 能原样穿过参数准备阶段。
describe("fabric_exec 的宿主 prelude 通道", () => {
  const prepareWith = (source: string, prelude?: string) =>
    new TypeScriptKernelRuntime("quickjs").prepare(source, false, [], {}, [], prelude);

  const prepare = (prelude?: string) => prepareWith("return 1;", prelude);

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

  it("模型代码看得到 prelude 声明的符号，且行号仍相对模型代码", () => {
    // 门禁把 prelude 一起编译，是为了让模型能调用宿主注入的符号（staffs.* 之类）；
    // 但 prelude 占的行必须从诊断行号里减掉，否则每一次报错位置都会假性下移。
    const visible = prepareWith(
      "return double(helper);",
      "const helper = 41;\nfunction double(value) { return value * 2; }\n",
    );
    expect(visible.checked.errors).toEqual([]);

    const broken = prepareWith(
      "const a = 1;\nconst b = a + notDeclaredAnywhere;\n",
      "const helper = 41;\n",
    );
    expect(broken.checked.errors).toHaveLength(1);
    expect(broken.checked.errors[0]?.line).toBe(2);
    expect(broken.checked.errors[0]?.message).toContain("notDeclaredAnywhere");
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
