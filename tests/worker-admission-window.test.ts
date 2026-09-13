import { describe, expect, it } from "vitest";
import {
  modelAdmissionTimeoutMs,
} from "../src/worker.js";

// admission 窗口决定「派发子 pi 后等多久算它没起来」。窗口太小会把启动期的派发整片误杀
// （本机实测约 34s，原 15s 就是这么死的），所以它必须可覆写；非法值必须退回默认，
// 因为 NaN 会让 setTimeout 立刻触发、把每次派发都判死。
describe("admission 窗口取值", () => {
  it("默认 90s", () => {
    expect(modelAdmissionTimeoutMs({})).toBe(90_000);
  });

  it("PI_FABRIC_MODEL_ADMISSION_TIMEOUT_MS 覆写（毫秒，允许空白与小数）", () => {
    expect(
      modelAdmissionTimeoutMs({
        PI_FABRIC_MODEL_ADMISSION_TIMEOUT_MS: "150000",
      }),
    ).toBe(150_000);
    expect(
      modelAdmissionTimeoutMs({
        PI_FABRIC_MODEL_ADMISSION_TIMEOUT_MS: " 2000 ",
      }),
    ).toBe(2_000);
    expect(
      modelAdmissionTimeoutMs({
        PI_FABRIC_MODEL_ADMISSION_TIMEOUT_MS: "1500.7",
      }),
    ).toBe(1_500);
  });

  it("非法值（非数字 / 0 / 负数 / Infinity / 空白）一律退回默认", () => {
    for (const raw of ["abc", "0", "-5", "NaN", "Infinity", "   "]) {
      expect(
        modelAdmissionTimeoutMs({
          PI_FABRIC_MODEL_ADMISSION_TIMEOUT_MS: raw,
        }),
      ).toBe(90_000);
    }
  });
});
