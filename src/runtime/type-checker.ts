import path from "node:path";
import ts from "typescript";

export interface FabricTypeError {
  line: number;
  column: number;
  message: string;
}

export interface FabricTypeCheckResult {
  errors: FabricTypeError[];
  javascript?: string;
  sourceMap?: string;
}

const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: false,
  noImplicitAny: false,
  strictNullChecks: false,
  strictFunctionTypes: false,
  strictBindCallApply: false,
  alwaysStrict: false,
  strictPropertyInitialization: false,
  noImplicitThis: false,
  useUnknownInCatchVariables: false,
  noEmit: false,
  sourceMap: true,
  skipLibCheck: true,
  lib: ["lib.es2022.d.ts"],
};

const TYPE_CORRECTNESS_CODES = new Set<number>([
  2339, 2551,
  2322, 2345, 2367,
  2531, 2532, 18047, 18048,
  7006, 7008, 7019, 7031, 7032, 7033, 7034,
]);

let nextCheckerId = 0;

export const normalizeTypeScriptPath = (fileName: string): string =>
  fileName.replaceAll("\\", "/");

/**
 * Guest programs execute inside this wrapper; user code starts on wrapped line 2.
 * 宿主 prelude 也插进这个 wrapper 内部（见 guest-prelude.ts），所以这行文本是拼接锚点：
 * 改它要连带改 guest-prelude.ts 的 GUEST_WRAPPER_OPEN 匹配逻辑。
 */
export const GUEST_WRAPPER_OPEN = "async function __piFabricMain() {";
const wrapFabricGuestCode = (code: string): string =>
  `${GUEST_WRAPPER_OPEN}\n${code}\n}\n`;

/**
 * 一段源码在 wrapper 里占多少行。
 * 宿主 prelude 插进同一作用域后，guest 源码行号整体后移这个量，
 * 所以门禁减行号（本文件）与源映射补空映射（guest-prelude.ts）必须同口径。
 */
export const countGuestLines = (text: string): number => {
  let lines = 1;
  for (const char of text) if (char === "\n") lines += 1;
  return lines;
};

class FabricTypeChecker {
  readonly #guestFile: string;
  readonly #declarationFile: string;
  readonly #baseHost = ts.createCompilerHost(compilerOptions, true);
  readonly #stableFiles = new Map<string, ts.SourceFile>();
  readonly #declarationSource: ts.SourceFile;
  readonly #host: ts.CompilerHost;
  #sourceText = "";
  #sourceFile: ts.SourceFile;
  #program: ts.Program | undefined;

  constructor(readonly declarations: string) {
    const id = ++nextCheckerId;
    this.#guestFile = normalizeTypeScriptPath(path.resolve(`/__pi_fabric_guest_${id}.ts`));
    this.#declarationFile = normalizeTypeScriptPath(
      path.resolve(`/__pi_fabric_globals_${id}.d.ts`),
    );
    this.#sourceFile = ts.createSourceFile(
      this.#guestFile,
      "",
      ts.ScriptTarget.ES2022,
      true,
    );
    this.#declarationSource = ts.createSourceFile(
      this.#declarationFile,
      declarations,
      ts.ScriptTarget.ES2022,
      true,
    );
    const isGuestFile = (fileName: string): boolean =>
      this.#baseHost.getCanonicalFileName(normalizeTypeScriptPath(fileName)) ===
      this.#baseHost.getCanonicalFileName(this.#guestFile);
    const isDeclarationFile = (fileName: string): boolean =>
      this.#baseHost.getCanonicalFileName(normalizeTypeScriptPath(fileName)) ===
      this.#baseHost.getCanonicalFileName(this.#declarationFile);
    this.#host = {
      ...this.#baseHost,
      fileExists: (fileName) =>
        isGuestFile(fileName) ||
        isDeclarationFile(fileName) ||
        this.#baseHost.fileExists(fileName),
      readFile: (fileName) => {
        if (isGuestFile(fileName)) return this.#sourceText;
        if (isDeclarationFile(fileName)) return this.declarations;
        return this.#baseHost.readFile(fileName);
      },
      getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
        if (isGuestFile(fileName)) return this.#sourceFile;
        if (isDeclarationFile(fileName)) return this.#declarationSource;
        const cached = this.#stableFiles.get(fileName);
        if (cached) return cached;
        const source = this.#baseHost.getSourceFile(
          fileName,
          languageVersion,
          onError,
          shouldCreateNewSourceFile,
        );
        if (source) this.#stableFiles.set(fileName, source);
        return source;
      },
    };
  }

  check(code: string, prelude?: string, includeTypeCorrectness = false): FabricTypeCheckResult {
    // 宿主 prelude 必须参与这次编译：模型代码要能看到它声明的符号（扩展注入的 staffs.* 之类），
    // 否则门禁会把模型的每一次调用都判成 Cannot find name —— 那正是 prelude 通道要治的病。
    // 代价是诊断行号整体后移，所以下面统一减掉 prelude 占的行数，并把落在 prelude 行域内的诊断丢掉
    // （prelude 自己已过独立门禁，见 typeCheckGuestPrelude）。
    const hostPrelude = prelude?.trim() ? prelude : undefined;
    const preludeLines = hostPrelude === undefined ? 0 : countGuestLines(hostPrelude);
    this.#sourceText = wrapFabricGuestCode(
      hostPrelude === undefined ? code : `${hostPrelude}\n${code}`,
    );
    this.#sourceFile = ts.createSourceFile(
      this.#guestFile,
      this.#sourceText,
      ts.ScriptTarget.ES2022,
      true,
    );
    const program = ts.createProgram({
      rootNames: [this.#declarationFile, this.#guestFile],
      options: compilerOptions,
      host: this.#host,
      ...(this.#program ? { oldProgram: this.#program } : {}),
    });
    this.#program = program;
    const diagnostics = [
      ...program.getSyntacticDiagnostics(this.#sourceFile),
      ...program
        .getSemanticDiagnostics(this.#sourceFile)
        .filter((diagnostic) => includeTypeCorrectness || !TYPE_CORRECTNESS_CODES.has(diagnostic.code)),
    ];
    const errors = diagnostics.map((diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
      if (!diagnostic.file || diagnostic.start === undefined) {
        return { line: 0, column: 0, message };
      }
      const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      return {
        line: Math.max(1, position.line),
        column: position.character + 1,
        message,
      };
    });
    // 含 prelude 的那份源码里，模型代码的第 1 行排在 prelude 之后，行号要减回去；
    // 行号落在 prelude 行域内的诊断属于宿主 prelude，不是模型代码的错（line 0 是拿不到位置的诊断，保留）。
    const relocated =
      preludeLines === 0
        ? errors
        : errors
            .filter((error) => error.line === 0 || error.line > preludeLines)
            .map((error) =>
              error.line === 0 ? error : { ...error, line: error.line - preludeLines },
            );
    if (relocated.length > 0) return { errors: relocated };

    if (preludeLines > 0) {
      // 有宿主 prelude 时不能再用 program.emit：那份 emitted JS 里已经含 prelude（执行期还会再拼一次），
      // 且它源映射的源行号是「含 prelude 的源码行号」，运行时报错位置会整体漂移。
      // 隔离转译只处理模型自己的代码，对这个 wrapper 而言输出与 program.emit 等价。
      const transpiled = transpileFabricCodeWithSourceMap(code);
      return {
        errors: relocated,
        javascript: transpiled.code,
        ...(transpiled.sourceMap ? { sourceMap: transpiled.sourceMap } : {}),
      };
    }

    let javascript: string | undefined;
    let sourceMap: string | undefined;
    program.emit(this.#sourceFile, (fileName, content) => {
      if (fileName.endsWith(".js.map")) sourceMap = content;
      else if (fileName.endsWith(".js")) javascript = content;
    });
    return {
      errors: relocated,
      ...(javascript ? { javascript } : {}),
      ...(sourceMap ? { sourceMap } : {}),
    };
  }
}

const checkerCache = new Map<string, FabricTypeChecker>();
const MAX_CHECKERS = 4;

const checkerFor = (declarations: string): FabricTypeChecker => {
  const cached = checkerCache.get(declarations);
  if (cached) {
    checkerCache.delete(declarations);
    checkerCache.set(declarations, cached);
    return cached;
  }
  const checker = new FabricTypeChecker(declarations);
  checkerCache.set(declarations, checker);
  while (checkerCache.size > MAX_CHECKERS) {
    const oldest = checkerCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    checkerCache.delete(oldest);
  }
  return checker;
};

export interface FabricTranspileResult {
  code: string;
  sourceMap?: string;
}

export const transpileFabricCodeWithSourceMap = (code: string): FabricTranspileResult => {
  const result = ts.transpileModule(wrapFabricGuestCode(code), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      sourceMap: true,
    },
  });
  return {
    code: result.outputText,
    ...(result.sourceMapText ? { sourceMap: result.sourceMapText } : {}),
  };
};

/**
 * 模型代码的类型门禁。`prelude` 是宿主注入的 guest prelude 源码（可选）：
 * 传了就参与编译（符号对模型代码可见），但既不贡献诊断、也不吃行号。
 */
export const typeCheckFabricCode = (
  code: string,
  declarations: string,
  prelude?: string,
  includeTypeCorrectness = false,
): FabricTypeCheckResult => checkerFor(declarations).check(code, prelude, includeTypeCorrectness);

/**
 * prelude 的独立门禁缓存。
 * 键是「声明文本 + prelude 源码」：声明随当次会话的工具体系变化，prelude 由扩展按配置生成，
 * 两者都不常变，命中率很高；而 prelude 动辄几百行，每次 fabric_exec 都重查一遍是纯浪费。
 *
 * 为什么要独立 checker：checker 内部持有增量 program，与模型代码那份门禁共用实例会让双方的
 * 增量信息互相作废，所以冷启动那一次单独 new 一个。
 * 为什么缓存里不留 checker：命中时直接返回结果，checker 此后再没被用过；留着只是把增量 program
 * 一并钉在内存里（4 条 prelude 就是 4 份 program），收益为零。
 */
const guestPreludeCache = new Map<string, FabricTypeCheckResult>();
const MAX_GUEST_PRELUDES = 4;

/** 宿主 prelude 的类型门禁：与模型代码完全分开，行号只相对 prelude 自己。 */
export const typeCheckGuestPrelude = (
  prelude: string,
  declarations: string,
): FabricTypeCheckResult => {
  const key = `${declarations}\u0000${prelude}`;
  const cached = guestPreludeCache.get(key);
  if (cached) {
    guestPreludeCache.delete(key);
    guestPreludeCache.set(key, cached);
    return cached;
  }
  const checker = new FabricTypeChecker(declarations);
  const checked = checker.check(prelude);
  // prelude 要插进 guest wrapper **内部**、与模型代码共享作用域，所以能带出去的是「执行体」；
  // 带 wrapper 的那份 emitted JS 一旦前置，就成了第二个 __piFabricMain 声明，直接顶掉模型代码。
  // 诊断仍然来自带 wrapper 的那一次检查（行号只相对 prelude 自己）。
  const result: FabricTypeCheckResult =
    checked.errors.length > 0
      ? { errors: checked.errors }
      : { errors: [], javascript: transpileGuestPreludeBody(prelude) };
  guestPreludeCache.set(key, result);
  while (guestPreludeCache.size > MAX_GUEST_PRELUDES) {
    const oldest = guestPreludeCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    guestPreludeCache.delete(oldest);
  }
  return result;
};

/** prelude 的执行体：与模型代码同一作用域，但不带 guest wrapper。 */
export const transpileGuestPreludeBody = (prelude: string): string =>
  ts.transpileModule(prelude, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText;

/** 仅测试用：清空 prelude 门禁缓存（生产路径没有清空的需求）。 */
export const resetGuestPreludeCache = (): void => {
  guestPreludeCache.clear();
};


