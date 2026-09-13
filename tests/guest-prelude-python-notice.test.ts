import { describe, expect, it } from "vitest";
import {
  IGNORED_PYTHON_PRELUDE_NOTICE,
  ignoredPreludeNotice,
} from "../src/runtime/guest-prelude.js";

// python 内核（CPython）跑不了 JS prelude：扩展挂了 prelude 却拿不到符号，在 guest 里只表现为
// “xxx is not defined”。这条日志就是把它变成说得清的错，而不是静默丢弃。
describe("python 内核对宿主 prelude 的处置", () => {
  it("python + 有 prelude：给出模型可见的解释", () => {
    const notice = ignoredPreludeNotice({
      python: true,
      prelude: "const x = 1;",
    });
    expect(notice).toBe(IGNORED_PYTHON_PRELUDE_NOTICE);
    expect(notice).toContain("python kernel");
  });

  it("python 没挂 prelude、或只有空白：不刷日志", () => {
    expect(ignoredPreludeNotice({ python: true })).toBeUndefined();
    expect(
      ignoredPreludeNotice({ python: true, prelude: "  \n " }),
    ).toBeUndefined();
  });

  it("typescript 内核挂了 prelude：走正常通道，无需解释", () => {
    expect(
      ignoredPreludeNotice({ python: false, prelude: "const x = 1;" }),
    ).toBeUndefined();
  });
});
