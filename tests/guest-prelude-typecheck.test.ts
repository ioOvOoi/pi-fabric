import { describe, expect, it } from "vitest";
import { GUEST_TYPE_DECLARATIONS } from "../src/runtime/guest-types.js";
import {
  resetGuestPreludeCache,
  transpileGuestPreludeBody,
  typeCheckFabricCode,
  typeCheckGuestPrelude,
} from "../src/runtime/type-checker.js";

describe("宿主 guest prelude 的独立类型门禁", () => {
  it("prelude 的错误按 prelude 自己的行号报出来", () => {
    resetGuestPreludeCache();
    const result = typeCheckGuestPrelude(
      "const a = 1;\nconst b = missingHelper();\n",
      GUEST_TYPE_DECLARATIONS,
    );
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((error) => error.line === 2)).toBe(true);
    expect(result.errors.every((error) => error.line >= 1 && error.line <= 3)).toBe(true);
  });

  it("干净 prelude 给出的是执行体，不带 guest wrapper", () => {
    resetGuestPreludeCache();
    const prelude = "const helper = 1;\n";
    const first = typeCheckGuestPrelude(prelude, GUEST_TYPE_DECLARATIONS);
    expect(first.errors).toEqual([]);
    expect(first.javascript).toContain("const helper = 1;");
    // 带 wrapper 的 prelude 会被拼成第二个 __piFabricMain，直接顶掉模型代码那份函数声明。
    expect(first.javascript).not.toContain("__piFabricMain");
    expect(transpileGuestPreludeBody(prelude)).not.toContain("__piFabricMain");
    expect(typeCheckGuestPrelude(prelude, GUEST_TYPE_DECLARATIONS)).toBe(first);
  });

  it("prelude 的门禁结果不影响模型代码的门禁结果", () => {
    resetGuestPreludeCache();
    const broken = typeCheckGuestPrelude("const bad = notDefinedAnywhere;\n", GUEST_TYPE_DECLARATIONS);
    expect(broken.errors.length).toBeGreaterThan(0);
    const clean = typeCheckFabricCode("return 1;", GUEST_TYPE_DECLARATIONS);
    expect(clean.errors).toEqual([]);
    expect(clean.javascript).toContain("async function __piFabricMain()");
  });
});
