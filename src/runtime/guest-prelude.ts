/**
 * 宿主 guest prelude 通道。
 *
 * 扩展（例如 Pi-Staffs）需要在模型代码之前注入一段辅助代码。此前唯一可行的做法是在工具入参上做
 * 字符串前置拼接，代价是注入代码与模型代码共用同一份类型门禁、同一张源映射：
 *  - prelude 里任何一个类型错误都会以「模型代码的行号」报出来，且门禁失败直接拒绝执行，
 *    等于把整条 fabric_exec 通道打死；
 *  - 源映射整体下移，运行时错误定位跟着漂移。
 *
 * 所以把 prelude 正式建模成宿主自己的代码层：类型门禁由执行服务单独做（见 type-checker.ts 的
 * typeCheckGuestPrelude），执行阶段在这里与模型代码的 emitted JS 拼接，并按 prelude 的实际行数
 * 把源映射整体下移。
 */

import { GUEST_WRAPPER_OPEN, countGuestLines } from "./type-checker.js";

export interface FabricGuestBundle {
  /** 拼接后的 emitted JS；没有可执行代码时缺省，调用方退回按源码转译。 */
  code?: string;
  sourceMap?: string;
}

/** prelude 与模型代码之间固定一个换行；源映射的行数偏移就由它界定。 */
const BUNDLE_SEPARATOR = "\n";

/**
 * 定位 guest wrapper 内部、模型代码开始处（即 wrapper 开头那一行之后）的偏移。
 * 找不到就返回 undefined——锚点是 type-checker 生成 wrapper 时用的同一段文本，
 * 出现找不到只可能是两边不同步，此时按「不拼接」处理更安全。
 */
const wrapperBodyAnchor = (code: string): number | undefined => {
  const opening = `${GUEST_WRAPPER_OPEN}${BUNDLE_SEPARATOR}`;
  const at = code.indexOf(opening);
  return at < 0 ? undefined : at + opening.length;
};

/**
 * 把源映射整体下移 `lineCount` 行。source map 的 `mappings` 以行为单位、用 `;` 分隔，
 * 因此下移 N 行就是在最前面补 N 个 `;`。
 *
 * 解析失败一律原样返回：源映射只影响错误定位的可读性，不能因为它把执行带崩。
 */
export const shiftSourceMapLines = (
  sourceMap: string | undefined,
  lineCount: number,
): string | undefined => {
  if (!sourceMap || lineCount <= 0) return sourceMap;
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceMap);
  } catch {
    return sourceMap;
  }
  if (typeof parsed !== "object" || parsed === null) return sourceMap;
  const mapping = parsed as { mappings?: unknown };
  if (typeof mapping.mappings !== "string" || mapping.mappings.length === 0) return sourceMap;
  mapping.mappings = ";".repeat(lineCount) + mapping.mappings;
  return JSON.stringify(parsed);
};

/**
 * 拼接执行用的 guest bundle。
 * - 没有 prelude：原样返回，行为与旧路径完全一致。
 * - 有 prelude 但没有 emitted JS：放弃拼接（宁可只跑模型代码，也不能只跑宿主层）。
 * - prelude 只有空白：等同于没有 prelude（空白拼接没有任何语义，却会让行号整体偏移）。
 */
export const composeGuestBundle = (parts: {
  prelude?: string | undefined;
  code?: string | undefined;
  sourceMap?: string | undefined;
}): FabricGuestBundle => {
  const { code, sourceMap } = parts;
  const prelude = parts.prelude?.trim() ? parts.prelude : undefined;
  if (!code) return {};
  const anchored = prelude === undefined ? undefined : wrapperBodyAnchor(code);
  if (prelude === undefined || anchored === undefined) {
    // 没有 prelude（旧路径），或者 emitted JS 里找不到 wrapper 锚点：都原样返回。
    // 宁可让宿主 prelude 不生效，也不能拼出一段跑不起来、或者把模型代码顶掉的代码。
    const bundle: FabricGuestBundle = { code };
    if (sourceMap !== undefined) bundle.sourceMap = sourceMap;
    return bundle;
  }
  // prelude 落在 wrapper 内部：与模型代码同一作用域（宿主 prelude 因此能定义模型代码要用的符号）。
  // 只写实际存在的字段：tsconfig 开了 exactOptionalPropertyTypes，
  // 展开出一个值为 undefined 的可选字段本身就不合法。
  const bundle: FabricGuestBundle = {
    code: `${code.slice(0, anchored)}${prelude}${BUNDLE_SEPARATOR}${code.slice(anchored)}`,
  };
  const shifted = shiftSourceMapLines(sourceMap, countGuestLines(prelude));
  if (shifted !== undefined) bundle.sourceMap = shifted;
  return bundle;
};

/** python 内核挂 prelude 时给模型看的那条日志（不需要说明时返回 undefined）。 */
export const IGNORED_PYTHON_PRELUDE_NOTICE =
  "Host guest prelude was ignored: it is JavaScript, and the python kernel cannot run it. Use the typescript kernel whenever your extension injects a prelude.";

/**
 * python 内核跑的是 CPython，宿主 prelude 是 JS：拼进去只会得到语法错，所以它不参与 python 执行。
 * 但扩展是按契约挂 prelude 的，静默丢弃会让调用方在 guest 里吃到 “xxx is not defined” 这种看不出原因
 * 的错（模型只能靠猜）——所以这里给出模型可见的日志，说清被忽略了以及怎么才能生效。
 */
export const ignoredPreludeNotice = (input: {
  python: boolean;
  prelude?: string | undefined;
}): string | undefined =>
  input.python && input.prelude?.trim()
    ? IGNORED_PYTHON_PRELUDE_NOTICE
    : undefined;
