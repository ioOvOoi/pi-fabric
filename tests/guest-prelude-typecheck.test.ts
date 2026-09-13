import { describe, expect, it } from "vitest";
import { GUEST_TYPE_DECLARATIONS } from "../src/runtime/guest-types.js";
import {
  resetGuestPreludeCache,
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

  it("干净 prelude 给出 emitted JS，且同文本命中缓存", () => {
    resetGuestPreludeCache();
    const prelude = "const helper = 1;\n";
    const first = typeCheckGuestPrelude(prelude, GUEST_TYPE_DECLARATIONS);
    expect(first.errors).toEqual([]);
    expect(first.javascript).toContain("const helper = 1;");
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
