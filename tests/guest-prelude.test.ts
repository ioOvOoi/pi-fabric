import { describe, expect, it } from "vitest";
import { composeGuestBundle, shiftSourceMapLines } from "../src/runtime/guest-prelude.js";

const map = (mappings: string): string =>
  JSON.stringify({ version: 3, sources: ["guest.ts"], names: [], mappings });

describe("宿主 guest prelude 拼接", () => {
  it("没有 prelude 时原样返回，旧路径行为不变", () => {
    const bundle = composeGuestBundle({ code: "BODY", sourceMap: map("AAAA") });
    expect(bundle).toEqual({ code: "BODY", sourceMap: map("AAAA") });
  });

  it("prelude 拼在模型代码之前，并按 prelude 行数下移源映射", () => {
    const bundle = composeGuestBundle({
      prelude: "const helper = 1;\n",
      code: "BODY",
      sourceMap: map("AAAA"),
    });
    expect(bundle.code).toBe("const helper = 1;\n\nBODY");
    expect(JSON.parse(bundle.sourceMap ?? "{}").mappings).toBe(";;AAAA");
  });

  it("没有 emitted JS 时不拼接 prelude：不能只跑宿主层", () => {
    expect(composeGuestBundle({ prelude: "const a = 1;\n" })).toEqual({});
  });

  it("纯空白 prelude 等同于没有 prelude", () => {
    expect(composeGuestBundle({ prelude: "  \n", code: "BODY", sourceMap: map("AAAA") })).toEqual({
      code: "BODY",
      sourceMap: map("AAAA"),
    });
  });

  it("源映射不可解析时原样返回，不阻断执行", () => {
    expect(shiftSourceMapLines("not-json", 3)).toBe("not-json");
    expect(shiftSourceMapLines(undefined, 3)).toBeUndefined();
    expect(shiftSourceMapLines(map("AAAA"), 0)).toBe(map("AAAA"));
    expect(shiftSourceMapLines(JSON.stringify({ version: 3 }), 2)).toBe(JSON.stringify({ version: 3 }));
  });
});
