/**
 * CPython 解释器解析：发现 → 探针验证 → 首个可用者胜出。
 *
 * 为什么单开这一层：`executor.cpython.binary` 默认是 "python3"，而「PATH 上有个叫 python3 的东西」
 * 并不代表它可用。Windows 上微软商店的 App Execution Alias 就是一个存在且可执行的 python3.exe，
 * 一跑就退 49；只装了官方安装器（python.exe）而没有 python3 别名的机器同样中招。旧实现只要
 * access(X_OK) 成功就把它当解释器用，于是 python 内核在这类机器上必炸，报出的还是一句与真实原因
 * 无关的启动错误。
 *
 * 现在的语义：
 *  - 候选：配置值永远排第一；只有配置值本身就是默认名（python3/python）时才补另一个默认名。
 *    显式配置其它名字或绝对路径一律不回退——免得调用方的明确选择被悄悄换成另一个解释器。
 *  - 验证：候选必须真的跑通一段 `-I -B -c` 探针（CPython 且 >= 3.10）才算可用。
 *  - 失败：把「试过谁、各自为什么失败」原样带进错误，并保留 executor.cpython.binary 字样，
 *    好让 python-error-guidance 的恢复提示照常触发。
 */

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import path from "node:path";

/** 探针源码：身份要求与运行时子进程一致（CPython >= 3.10），成功后打印解释器路径。 */
export const CPYTHON_PROBE_SOURCE =
  "import sys; assert sys.implementation.name == 'cpython' and sys.version_info >= (3, 10); print(sys.executable)";

const PROBE_TIMEOUT_MS = 10_000;
/** 只给默认名补回退：显式配置的名字代表调用方知道自己在选哪个解释器。 */
const DEFAULT_BINARY_NAMES = ["python3", "python"] as const;
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** aborted=true 表示「这次解析是被取消掉的」，而不是「这台机器上没有可用的解释器」。 */
export type CpythonInterpreterResolution =
  | { ok: true; command: string }
  | { ok: false; message: string; aborted?: boolean };
export type CpythonProbeResult = { ok: true; executable: string } | { ok: false; reason: string; aborted?: boolean };
/** 探针必须能取消：否则取消之后我们仍然会起一个解释器进程去验证候选。 */
export type CpythonInterpreterProbe = (command: string, signal?: AbortSignal) => Promise<CpythonProbeResult>;

/** 候选顺序：配置值在前，只有默认名才追加另一个默认名。 */
export const cpythonInterpreterCandidates = (binary: string): string[] => {
  const configured = binary.trim();
  if (configured.length === 0) return [];
  const explicitPath = path.isAbsolute(configured) || configured.includes("/") || configured.includes("\\");
  if (explicitPath) return [configured];
  return (DEFAULT_BINARY_NAMES as readonly string[]).includes(configured)
    ? [...new Set<string>([configured, ...DEFAULT_BINARY_NAMES])]
    : [configured];
};

/**
 * 在 PATH（或显式路径）上定位可执行文件，查找规则与 spawn 保持一致。
 * 找不到返回 undefined——由调用方决定要不要换下一个候选。
 */
export const locateCpythonExecutable = async (binary: string, cwd: string): Promise<string | undefined> => {
  // Windows stores executables with PATHEXT suffixes ("python3" -> "python3.exe");
  // probe the variants spawn would find instead of failing on the bare name.
  const extensions = process.platform === "win32"
    ? String(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [];
  const variants = (candidate: string): string[] =>
    extensions.length && !/\.[A-Za-z0-9]+$/.test(candidate)
      ? [candidate, ...extensions.map((extension) => candidate + extension)]
      : [candidate];
  const candidates = path.isAbsolute(binary) || binary.includes("/") || binary.includes("\\")
    ? [path.resolve(cwd, binary)]
    : (process.env.PATH ?? "").split(path.delimiter).map((directory) => path.resolve(cwd, directory || ".", binary));
  for (const candidate of candidates) {
    for (const variant of variants(candidate)) {
      try {
        await access(variant, constants.X_OK);
        return await realpath(variant);
      } catch {
        // Continue only during executable discovery, never after a failed spawn.
      }
    }
  }
  return undefined;
};

/** 真探针：跑一次解释器，要求它是 CPython >= 3.10，并回报它自己认为的 sys.executable。 */
export const probeCpythonInterpreter: CpythonInterpreterProbe = (command, signal) =>
  new Promise<CpythonProbeResult>((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, reason: "cancelled before the interpreter probe started", aborted: true });
      return;
    }
    const child = spawn(command, ["-I", "-B", "-c", CPYTHON_PROBE_SOURCE], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: CpythonProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, reason: `probe timed out after ${PROBE_TIMEOUT_MS}ms` });
    }, PROBE_TIMEOUT_MS);
    timer.unref();
    // 取消发生在探针进行中：杀掉探针进程并如实回报「被取消」，让调用方走 aborted 分支。
    const onAbort = (): void => {
      child.kill();
      finish({ ok: false, reason: "cancelled during the interpreter probe", aborted: true });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => finish({ ok: false, reason: `cannot start: ${errorText(error)}` }));
    child.on("close", (status) => {
      if (status !== 0) {
        const detail = stderr.trim().split("\n")[0] ?? "";
        finish({ ok: false, reason: `probe exited ${status ?? "on signal"}: ${detail || "no stderr"}` });
        return;
      }
      const reported = stdout.trim().split("\n").pop()?.trim() ?? "";
      if (reported.length === 0) {
        finish({ ok: false, reason: "probe reported no interpreter path" });
        return;
      }
      finish({ ok: true, executable: reported });
    });
  });

/**
 * 解析结果缓存：解析要起进程验证，不该每次执行都重跑。
 * 只缓存成功——失败可能只是「刚刚装好 Python」，别把失败钉死在进程生命周期里。
 */
const resolutionCache = new Map<string, CpythonInterpreterResolution>();

/**
 * 显式失效缓存：进程运行期间用户装了新的 Python、或换了 PATH，都可以清一次再解析。
 * （失败与取消本来就不写缓存，所以这里只需要给「已经成功」的场景一个出口。）
 */
export const clearCpythonInterpreterCache = (): void => {
  resolutionCache.clear();
};

export const resolveCpythonInterpreter = async (
  binary: string,
  cwd: string,
  options: { probe?: CpythonInterpreterProbe; cache?: boolean; signal?: AbortSignal | undefined } = {},
): Promise<CpythonInterpreterResolution> => {
  // 取消语义优先于缓存：被取消的执行不该拿到一个「已解析」的结果去起子进程。
  const cancelled = (): CpythonInterpreterResolution =>
    ({ ok: false, message: "Execution cancelled during interpreter resolution", aborted: true });
  if (options.signal?.aborted) return cancelled();
  const candidates = cpythonInterpreterCandidates(binary);
  if (candidates.length === 0) {
    return { ok: false, message: "executor.cpython.binary is empty; set an interpreter name or an absolute path." };
  }
  const useCache = options.cache ?? true;
  // 绝对路径与 cwd 无关；相对名字必须带上 cwd，因为相对 PATH 项是相对调用目录解析的。
  const cacheKey = path.isAbsolute(candidates[0]!)
    ? candidates[0]!
    : `${path.resolve(cwd)}\u0000${candidates[0]!}`;
  const cached = useCache ? resolutionCache.get(cacheKey) : undefined;
  if (cached) return cached;
  const probe = options.probe ?? probeCpythonInterpreter;
  const failures: string[] = [];
  for (const candidate of candidates) {
    if (options.signal?.aborted) return cancelled();
    const located = await locateCpythonExecutable(candidate, cwd);
    // 文件探测（access）是最容易被卡住的一步，取消完全可能正好落在这里：
    // 这里不再查一次的话，取消之后我们还会去起探针进程。
    if (options.signal?.aborted) return cancelled();
    if (!located) {
      failures.push(`${candidate}: not found on PATH`);
      continue;
    }
    const result = await probe(located, options.signal);
    // 探针被取消不是候选失败，直接结束解析，也不要把取消写进失败清单、更不要缓存。
    if (!result.ok && result.aborted) return cancelled();
    if (!result.ok) {
      failures.push(`${candidate} (${located}): ${result.reason}`);
      continue;
    }
    const resolution: CpythonInterpreterResolution = { ok: true, command: result.executable.trim() || located };
    if (useCache) resolutionCache.set(cacheKey, resolution);
    return resolution;
  }
  return {
    ok: false,
    message: `No usable CPython 3.10+ interpreter. Tried ${candidates.join(", ")} — ${failures.join("; ")}. Set executor.cpython.binary to a trusted interpreter's absolute path.`,
  };
};
