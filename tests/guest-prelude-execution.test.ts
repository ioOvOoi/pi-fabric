import { describe, expect, it } from "vitest";
import { GUEST_TYPE_DECLARATIONS } from "../src/runtime/guest-types.js";
import { composeGuestBundle } from "../src/runtime/guest-prelude.js";
import { QuickJsRuntime } from "../src/runtime/quickjs-runtime.js";
import { transpileGuestPreludeBody, typeCheckFabricCode } from "../src/runtime/type-checker.js";

const options = {
  timeoutMs: 5_000,
  memoryLimitBytes: 32 * 1024 * 1024,
};

// 端到端探针：真的把拼接后的 bundle 丢进 QuickJS 跑一遍，验证宿主 prelude 通道的两条承诺
// （符号可见、模型代码的行号不因 prelude 漂移）。单元测试只保证拼接数学，这里保证能跑。
const execute = async (source: string, prelude?: string) => {
  // 宿主 prelude 要一起进编译：模型代码得看得见它声明的符号（这正是通道存在的理由）。
  // 形参顺序与上游一致：第三位是 includeTypeCorrectness，prelude 在末尾。
  const checked = typeCheckFabricCode(source, GUEST_TYPE_DECLARATIONS, false, prelude);
  expect(checked.errors).toEqual([]);
  const bundle = composeGuestBundle({
    ...(prelude === undefined ? {} : { prelude: transpileGuestPreludeBody(prelude) }),
    code: checked.javascript,
    sourceMap: checked.sourceMap,
  });
  return new QuickJsRuntime().execute(source, async () => undefined, {
    ...options,
    ...(bundle.code ? { transpiledCode: bundle.code } : {}),
    ...(bundle.sourceMap ? { transpiledSourceMap: bundle.sourceMap } : {}),
  });
};

describe("宿主 guest prelude 的真实执行", () => {
  it("prelude 里的符号对模型代码可见", async () => {
    const result = await execute(
      "return double(helper);",
      "const helper = 41;\nfunction double(value) { return value * 2; }\n",
    );
    expect(result.terminationReason).toBe("completed");
    expect(result.value).toBe(82);
  });

  it("prelude 不改变模型代码运行时报错的位置", async () => {
    const source = "const a = 1;\nconst b = a + 1;\nthrow new Error(`boom ${b}`);";
    const bare = await execute(source);
    const withPrelude = await execute(
      source,
      "const helper = 1;\nconst second = 2;\nconst third = 3;\n",
    );
    expect(bare.terminationReason).toBe("runtime_error");
    expect(withPrelude.terminationReason).toBe("runtime_error");
    expect(withPrelude.error).toBe(bare.error);
  });
});
