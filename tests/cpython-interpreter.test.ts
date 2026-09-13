import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CpythonInterpreterProbe,
  cpythonInterpreterCandidates,
  locateCpythonExecutable,
  resolveCpythonInterpreter,
} from "../src/runtime/cpython-interpreter.js";

const roots: string[] = [];
/** 建一个只有这几个「可执行文件」的临时目录；探测逻辑由注入的假探针接管，不会真跑东西。 */
const fixtureDir = (names: string[]): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-cpython-interpreter-"));
  roots.push(root);
  for (const name of names) fs.writeFileSync(path.join(root, name), "# stub\n", { mode: 0o755 });
  return root;
};

const failing: CpythonInterpreterProbe = async () => ({ ok: false, reason: "probe exited 49: stub" });
const accepting: CpythonInterpreterProbe = async (command) => ({ ok: true, executable: command });

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("候选顺序", () => {
  it("配置值优先，只有默认名才补另一个默认名", () => {
    expect(cpythonInterpreterCandidates("python3")).toEqual(["python3", "python"]);
    expect(cpythonInterpreterCandidates("python")).toEqual(["python", "python3"]);
    expect(cpythonInterpreterCandidates("python3.12")).toEqual(["python3.12"]);
    expect(cpythonInterpreterCandidates("python")).toEqual(["python", "python3"]);
    expect(cpythonInterpreterCandidates("/opt/python/bin/python3")).toEqual(["/opt/python/bin/python3"]);
    expect(cpythonInterpreterCandidates("   ")).toEqual([]);
  });
});

describe("可执行文件定位", () => {
  it("PATH 上没有该名字时返回 undefined", async () => {
    const root = fixtureDir([]);
    vi.stubEnv("PATH", root);
    await expect(locateCpythonExecutable("python3", root)).resolves.toBeUndefined();
  });
});

describe("解析：发现 + 探针验证", () => {
  it("第一个候选探针失败就换下一个，并用成功者回报的解释器路径", async () => {
    const root = fixtureDir(["python3", "python"]);
    vi.stubEnv("PATH", root);
    const probed: string[] = [];
    const probe: CpythonInterpreterProbe = async (command) => {
      const name = path.basename(command);
      probed.push(name);
      return name === "python3" ? { ok: false, reason: "probe exited 49: stub" } : { ok: true, executable: command };
    };
    const resolution = await resolveCpythonInterpreter("python3", root, { probe, cache: false });
    expect(probed).toEqual(["python3", "python"]);
    expect(resolution.ok).toBe(true);
    if (resolution.ok) expect(path.basename(resolution.command)).toBe("python");
  });

  it("全不可用时错误里带上试过谁、为什么失败，以及配置键", async () => {
    const root = fixtureDir(["python3", "python"]);
    vi.stubEnv("PATH", root);
    const resolution = await resolveCpythonInterpreter("python3", root, { probe: failing, cache: false });
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.message).toContain("python3");
      expect(resolution.message).toContain("python");
      expect(resolution.message).toContain("probe exited 49: stub");
      expect(resolution.message).toContain("executor.cpython.binary");
    }
  });

  it("显式路径找不到时不去探测别的解释器", async () => {
    const missing = path.join(fixtureDir([]), "missing-python");
    let probes = 0;
    const probe: CpythonInterpreterProbe = async () => { probes++; return { ok: true, executable: "x" }; };
    const resolution = await resolveCpythonInterpreter(missing, process.cwd(), { probe, cache: false });
    expect(resolution.ok).toBe(false);
    expect(probes).toBe(0);
  });

  it("自定义名字不回退：不让显式配置被悄悄换成别的解释器", async () => {
    const root = fixtureDir(["python", "python3.11"]);
    vi.stubEnv("PATH", root);
    const resolution = await resolveCpythonInterpreter("python3.11", root, { probe: failing, cache: false });
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.message).toContain("python3.11");
  });

  it("已取消时直接返回 aborted，连探针都不起", async () => {
    const root = fixtureDir(["python3"]);
    vi.stubEnv("PATH", root);
    const controller = new AbortController();
    controller.abort();
    let probes = 0;
    const probe: CpythonInterpreterProbe = async () => { probes++; return { ok: true, executable: "x" }; };
    const resolution = await resolveCpythonInterpreter("python3", root, { probe, cache: false, signal: controller.signal });
    expect(resolution).toMatchObject({ ok: false, aborted: true });
    expect(probes).toBe(0);
  });

  it("被取消的探针结果既不算候选失败也不进缓存", async () => {
    const root = fixtureDir(["python3"]);
    vi.stubEnv("PATH", root);
    let probes = 0;
    const probe: CpythonInterpreterProbe = async () => {
      probes++;
      return { ok: false, reason: "cancelled during the interpreter probe", aborted: true };
    };
    const first = await resolveCpythonInterpreter("python3", root, { probe });
    expect(first).toMatchObject({ ok: false, aborted: true });
    if (!first.ok) expect(first.message).toContain("cancelled");
    // 缓存必须跳过取消：否则下一次执行会拿着「取消」当成「这台机器没有 Python」。
    const second = await resolveCpythonInterpreter("python3", root, { probe });
    expect(second).toMatchObject({ ok: false, aborted: true });
    expect(probes).toBe(2);
  });

  it("成功结果进缓存：同一解释器名只探一次", async () => {
    const root = fixtureDir(["python3"]);
    vi.stubEnv("PATH", root);
    let probes = 0;
    const probe: CpythonInterpreterProbe = async (command) => { probes++; return { ok: true, executable: command }; };
    expect((await resolveCpythonInterpreter("python3", root, { probe })).ok).toBe(true);
    expect((await resolveCpythonInterpreter("python3", root, { probe })).ok).toBe(true);
    expect(probes).toBe(1);
  });
});

const usablePython = await resolveCpythonInterpreter("python", process.cwd(), { cache: false });

describe("真解释器：有则验证回退链，无则验证错误契约", () => {
  it("本机 python3 不可用（商店占位符/未安装）时回退到 python", async () => {
    const resolution = await resolveCpythonInterpreter("python3", process.cwd(), { cache: false });
    if (!usablePython.ok) {
      expect(resolution.ok).toBe(false);
      if (!resolution.ok) expect(resolution.message).toContain("executor.cpython.binary");
      return;
    }
    expect(resolution.ok).toBe(true);
    if (resolution.ok) expect(path.isAbsolute(resolution.command)).toBe(true);
  });

  it("完全不存在的名字报错，不会把 python 顶上去", async () => {
    const resolution = await resolveCpythonInterpreter("python3-definitely-missing", process.cwd(), { cache: false });
    expect(resolution.ok).toBe(false);
  });

  it("探针确实要求 CPython >= 3.10", async () => {
    const { CPYTHON_PROBE_SOURCE } = await import("../src/runtime/cpython-interpreter.js");
    expect(CPYTHON_PROBE_SOURCE).toContain("cpython");
    expect(CPYTHON_PROBE_SOURCE).toContain("version_info >= (3, 10)");
  });
});
