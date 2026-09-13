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

  check(code: string): FabricTypeCheckResult {
    this.#sourceText = wrapFabricGuestCode(code);
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
        .filter((diagnostic) => !TYPE_CORRECTNESS_CODES.has(diagnostic.code)),
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
    if (errors.length > 0) return { errors };

    let javascript: string | undefined;
    let sourceMap: string | undefined;
    program.emit(this.#sourceFile, (fileName, content) => {
      if (fileName.endsWith(".js.map")) sourceMap = content;
      else if (fileName.endsWith(".js")) javascript = content;
    });
    return {
      errors,
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

export const typeCheckFabricCode = (
  code: string,
  declarations: string,
): FabricTypeCheckResult => checkerFor(declarations).check(code);

/**
 * prelude 的独立门禁缓存。
 * 键是「声明文本 + prelude 源码」：声明随当次会话的工具体系变化，prelude 由扩展按配置生成，
 * 两者都不常变，命中率很高；而 prelude 动辄几百行，每次 fabric_exec 都重查一遍是纯浪费。
 *
 * 每个键配一个独立的 FabricTypeChecker 实例：checker 内部持有增量 program，
 * 与模型代码那份门禁共用实例会让双方的增量信息互相作废。
 */
const guestPreludeCache = new Map<
  string,
  { checker: FabricTypeChecker; result: FabricTypeCheckResult }
>();
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
    return cached.result;
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
  guestPreludeCache.set(key, { checker, result });
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

