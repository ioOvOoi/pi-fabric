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

export interface FabricGuestBundle {
  /** 拼接后的 emitted JS；没有可执行代码时缺省，调用方退回按源码转译。 */
  code?: string;
  sourceMap?: string;
}

/** prelude 与模型代码之间固定一个换行；源映射的行数偏移就由它界定。 */
const BUNDLE_SEPARATOR = "\n";

const countLines = (text: string): number => {
  let lines = 1;
  for (const char of text) if (char === "\n") lines += 1;
  return lines;
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
  // 只写实际存在的字段：tsconfig 开了 exactOptionalPropertyTypes，
  // 展开出一个值为 undefined 的可选字段本身就不合法。
  const bundle: FabricGuestBundle = { code };
  if (!prelude) {
    if (sourceMap !== undefined) bundle.sourceMap = sourceMap;
    return bundle;
  }
  bundle.code = `${prelude}${BUNDLE_SEPARATOR}${code}`;
  const shifted = shiftSourceMapLines(sourceMap, countLines(prelude));
  if (shifted !== undefined) bundle.sourceMap = shifted;
  return bundle;
};
