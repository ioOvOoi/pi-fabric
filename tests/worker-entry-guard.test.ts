import { describe, expect, it } from "vitest";

// worker.ts 既是子进程入口、又被测试直接 import：import 一次就会给宿主进程挂上
// process.exit(1) 的崩溃处理，并把 main() 真跑一遍——vitest 的 fork 池因此被打死
// （整套跑时报 "Unhandled Error" + "Worker exited unexpectedly"）。
// 这条守门断言：只被 import 时不得改变宿主进程的事件监听，也不得让进程退出。
describe("worker 入口守卫", () => {
  it("被 import 时不装崩溃处理、不执行 main", async () => {
    const before = {
      uncaught: process.listenerCount("uncaughtException"),
      rejection: process.listenerCount("unhandledRejection"),
    };
    const worker = await import("../src/worker.js");

    expect(typeof worker.modelAdmissionTimeoutMs).toBe("function");
    expect(process.listenerCount("uncaughtException")).toBe(before.uncaught);
    expect(process.listenerCount("unhandledRejection")).toBe(before.rejection);
    expect(process.exitCode ?? 0).toBe(0);
  });
});
