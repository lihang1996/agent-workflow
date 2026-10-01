import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  ArchitectureRequest,
  LocalArchitectureRequest,
  LocalProductSpecRequest,
  ProductSpecFlow,
  ProductSpecRequest,
} from './product-spec.js';
import { extractKnowledgeCitations } from './kb-prefetch.js';

/**
 * 完整制品摘要（AO-REQ-302 / 13 号 C2；W5 二轮返修强化）。
 *
 * 契约：「完整制品内容或文件集变化 ⇒ 原审批失效」。
 * - 本地模式对 spec 文件 + tickets 目录的全部 .md 做确定性递归枚举，逐文件
 *   内容摘要后以**无歧义 JSON 数组**计算完整清单摘要（换行分隔清单可被含
 *   换行的文件名构造碰撞，不再使用）。
 * - **Spec 不得兼作唯一 Ticket**：tickets 目录至少要有一个与 Spec 实际路径
 *   （文件身份）不同的 .md，`ticketsPath='.'` 只有 Spec 同样拒绝。
 * - **单次受控读取**：`readLocalArtifactSnapshot` 一次枚举同时返回 manifest
 *   摘要与同批正文，并在读后重列文件集 + 复核每个文件的身份（size/mtime），
 *   读取过程中文件集或内容变化 ⇒ `changed_during_read` 失败关闭——摘要与
 *   正文不可能来自不同版本（G1/提交点共用）。
 * - 飞书模式在完整 block 树/资源回读能力核验（U-3）前保持 blocked。
 */
export const DIGEST_ALGORITHM = 'canonical-sha256-v1' as const;
export type DigestAlgorithm = typeof DIGEST_ALGORITHM;

export type ArtifactDigestErrorCode =
  | 'spec_missing'
  | 'spec_not_file'
  | 'tickets_missing'
  | 'tickets_not_directory'
  | 'tickets_empty'
  | 'symlink_not_allowed'
  | 'path_escape'
  | 'unreadable'
  | 'changed_during_read'
  | 'path_swapped'
  | 'duplicate_manifest_path'
  | 'lark_digest_blocked';

export class ArtifactDigestError extends Error {
  constructor(readonly code: ArtifactDigestErrorCode, message: string) {
    super(message);
    this.name = 'ArtifactDigestError';
  }
}

export interface ArtifactFileDigest {
  /** 相对 workspace 的 POSIX 风格路径（specPath 或 ticketsPath 下的 .md）。 */
  path: string;
  sha256: string;
}

export interface LocalArtifactDigest {
  algorithm: DigestAlgorithm;
  /** 覆盖排序后完整文件清单的摘要；文件增删/内容变化都会改变它。 */
  digest: string;
  files: ArtifactFileDigest[];
  content_sources: Array<{ kind: 'local'; path: string }>;
}

/** 单次受控读取的结果：manifest 摘要与同批正文（同序，绝无二次读取）。 */
export interface LocalArtifactSnapshot {
  digest: LocalArtifactDigest;
  /** 与 digest.files 同序的正文（同一批 Buffer 解码）。 */
  texts: string[];
}

function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** POSIX 风格相对路径：保留文件名中的字面反斜杠（macOS 合法字符），不把它当分隔符转换。 */
function toPosix(path: string): string {
  return path;
}

/**
 * 逐个路径组件验证（root → candidate 的每一段都必须是真实目录/文件）：
 * 父目录若是符号链接，即使最终路径 lstat 不是链接也能绕过「一律拒绝符号链接」
 * 的声明——因此每个组件单独 lstat，任一组件是符号链接即拒绝。
 */
async function assertNoSymlinkComponents(root: string, candidate: string, label: string): Promise<void> {
  const segments = relative(root, candidate).split(sep).filter((segment) => segment.length > 0 && segment !== '.');
  let current = root;
  for (const segment of segments) {
    current = resolve(current, segment);
    const info = await lstat(current).catch(() => null);
    if (info === null) return; // 不存在的组件按缺失处理（后续 lstat/readFile 报缺失）
    if (info.isSymbolicLink()) {
      throw new ArtifactDigestError(
        'symlink_not_allowed',
        `${label} 的路径组件是符号链接，制品摘要拒绝符号链接（含父目录别名）: ${current}`,
      );
    }
  }
}

/** 校验通过时捕获的文件身份（校验批准的就是这个 inode；bigint 全套比对）。 */
interface ValidatedFile {
  realPath: string;
  dev: bigint;
  ino: bigint;
}

/**
 * 路径校验（W5 四轮 P0：三方身份绑定）：
 * 1. 逐组件拒绝符号链接（父目录别名在此拦截）；
 * 2. **初次 `lstat(candidate)`**（bigint）记录 dev/ino——身份链锚点；
 * 3. `realpath` 解析并做工作区包含检查；`afterResolve` 注入点之后对解析结果
 *    再 lstat：dev/ino 必须与锚点一致——解析窗口内祖先目录被换成指向工作区
 *    外的符号链接时，后续 lstat 会落到外部 inode，与锚点不符 ⇒ `path_swapped`
 *    拒绝，外部 inode 绝不成为「已校验身份」。
 */
async function assertRealInsideRoot(
  root: string,
  candidate: string,
  label: string,
  afterResolve?: (label: string) => Promise<void>,
): Promise<ValidatedFile> {
  await assertNoSymlinkComponents(root, candidate, label);
  const preStat = await lstat(candidate, { bigint: true }).catch(() => {
    throw new ArtifactDigestError('unreadable', `${label} 无法读取: ${candidate}`);
  });
  if (preStat.isSymbolicLink()) {
    throw new ArtifactDigestError(
      'symlink_not_allowed',
      `${label} 是符号链接，制品摘要拒绝符号链接（含指向工作区内部的别名）: ${candidate}`,
    );
  }
  const actual = await realpath(candidate);
  const rel = relative(root, actual);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ArtifactDigestError('path_escape', `${label} 解析后越出了工作区: ${candidate}`);
  }
  if (afterResolve) await afterResolve(label);
  const postStat = await lstat(actual, { bigint: true }).catch(() => {
    throw new ArtifactDigestError('unreadable', `${label} 无法读取: ${actual}`);
  });
  if (postStat.dev !== preStat.dev || postStat.ino !== preStat.ino) {
    throw new ArtifactDigestError(
      'path_swapped',
      `${label} 在路径解析窗口内被替换（祖先目录交换/同路径换文件），解析后 inode 与校验锚点不一致，失败关闭`,
    );
  }
  return { realPath: actual, dev: preStat.dev, ino: preStat.ino };
}

/** 枚举出的文件条目：manifest 相对路径 + 文件身份（bigint dev/ino）+ 读后身份。 */
interface CollectedArtifactFile {
  path: string;
  realPath: string;
  dev: bigint;
  ino: bigint;
  size: bigint;
  /** bigint Stats 的纳秒时间戳（mtimeNs/ctimeNs）——本 Node 需 {bigint:true} 才提供。 */
  mtimeNs: bigint;
  ctimeNs: bigint;
  buffer?: Buffer;
}

/** 身份指纹：真实路径 + inode + 尺寸 + 纳秒时间（稳定性复核逐文件比较）。 */
function identityOf(file: CollectedArtifactFile): string {
  return `${file.realPath}|${file.dev}|${file.ino}|${file.size}|${file.mtimeNs}|${file.ctimeNs}`;
}

/** 测试注入点：复现「解析后」「校验后/打开前」「读取后/复核前」时序窗口（只可能让读取更容易失败）。 */
export interface ArtifactReadHooks {
  afterResolve?: (label: string) => Promise<void>;
  afterValidate?: (relPath: string) => Promise<void>;
  afterFileRead?: (relPath: string) => Promise<void>;
}

/**
 * 受控打开并读取单个已校验文件（W5 三轮 P0 + 四轮强化）：
 * 1. 以句柄 `open(realPath)` 读取——正文永远来自实际打开的文件描述符，打开
 *    之后的路径交换不影响句柄内容；
 * 2. 打开后 fstat（bigint）与「校验锚点身份（首次 lstat 的 dev/ino）」「路径
 *    当前 lstat」三方比对：祖先目录被换成工作区外符号链接/同路径换文件 ⇒
 *    `path_swapped` 拒绝，绝不读取越界字节；
 * 3. readFile 后再次 fstat，与打开时身份逐项比较（dev/ino/size/mtimeNs/
 *    ctimeNs 纳秒精度）：读取窗口内被改写 ⇒ `changed_during_read`，post 元
 *    数据绝不当作读前值使用。
 */
async function openValidatedFile(
  validated: ValidatedFile,
  relPath: string,
  hooks?: ArtifactReadHooks,
): Promise<CollectedArtifactFile> {
  const handle = await open(validated.realPath, 'r').catch((error) => {
    throw new ArtifactDigestError('unreadable', `文件无法打开 ${relPath}: ${(error as Error).message}`);
  });
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== validated.dev || opened.ino !== validated.ino) {
      throw new ArtifactDigestError(
        'path_swapped',
        `文件在路径校验与实际打开之间被替换（同路径换文件/祖先目录交换）: ${relPath}，失败关闭`,
      );
    }
    const pathNow = await lstat(validated.realPath, { bigint: true }).catch(() => null);
    if (pathNow === null || pathNow.isSymbolicLink()
      || pathNow.dev !== opened.dev || pathNow.ino !== opened.ino) {
      throw new ArtifactDigestError(
        'path_swapped',
        `文件在路径校验与实际打开之间被换成符号链接或另一文件: ${relPath}，拒绝读取越界内容`,
      );
    }
    const buffer = await handle.readFile().catch((error) => {
      throw new ArtifactDigestError('unreadable', `文件无法读取 ${relPath}: ${(error as Error).message}`);
    });
    await hooks?.afterFileRead?.(relPath);
    const post = await handle.stat({ bigint: true });
    if (post.dev !== opened.dev || post.ino !== opened.ino
      || post.size !== opened.size || post.mtimeNs !== opened.mtimeNs || post.ctimeNs !== opened.ctimeNs) {
      throw new ArtifactDigestError(
        'changed_during_read',
        `文件在读取窗口内被改写（读前与读后身份不一致）: ${relPath}，失败关闭`,
      );
    }
    return {
      path: relPath,
      realPath: validated.realPath,
      dev: opened.dev,
      ino: opened.ino,
      size: post.size,
      mtimeNs: post.mtimeNs,
      ctimeNs: post.ctimeNs,
      buffer,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** 只列身份不读内容（第二轮稳定性复核用；同样用 bigint 全套身份）。 */
async function statValidatedFile(validated: ValidatedFile, relPath: string): Promise<CollectedArtifactFile> {
  const info = await lstat(validated.realPath, { bigint: true }).catch(() => {
    throw new ArtifactDigestError('unreadable', `文件无法读取 ${relPath}: ${validated.realPath}`);
  });
  return {
    path: relPath,
    realPath: validated.realPath,
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
  };
}

/** manifest 路径必须唯一：重复/别名歧义失败关闭。 */
function assertUniqueManifestPaths(files: CollectedArtifactFile[]): void {
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) {
      throw new ArtifactDigestError(
        'duplicate_manifest_path',
        `manifest 路径重复（同一路径枚举出多个条目）: ${file.path}，失败关闭`,
      );
    }
    seen.add(file.path);
  }
}

/**
 * 确定性递归枚举目录下全部 .md 文件；目录内出现符号链接一律拒绝；
 * 与 Spec 同一 inode（含硬链接）的文件不重复进入 manifest（Spec 只计一次）。
 */
async function collectMarkdownFiles(
  root: string,
  dir: string,
  prefix: string,
  specIdentity: { dev: bigint; ino: bigint },
  read: boolean,
  out: CollectedArtifactFile[],
  hooks?: ArtifactReadHooks,
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    // 只跳过确切的 .git 元数据目录；.github 等其他目录照常枚举（其下 .md 参与摘要）。
    if (entry.isDirectory() && entry.name === '.git') continue;
    const childPath = resolve(dir, entry.name);
    const relPath = toPosix(prefix ? `${prefix}/${entry.name}` : entry.name);
    if (entry.isSymbolicLink()) {
      throw new ArtifactDigestError(
        'symlink_not_allowed',
        `tickets 目录内存在符号链接，拒绝进入摘要: ${relPath}`,
      );
    }
    if (entry.isDirectory()) {
      await collectMarkdownFiles(root, childPath, relPath, specIdentity, read, out, hooks);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const validated = await assertRealInsideRoot(root, childPath, relPath, hooks?.afterResolve);
    // Spec 与本条目是同一文件（同 inode，含硬链接/同路径）：manifest 只保留 Spec 一次。
    if (validated.dev === specIdentity.dev && validated.ino === specIdentity.ino) continue;
    await hooks?.afterValidate?.(relPath);
    out.push(read
      ? await openValidatedFile(validated, relPath, hooks)
      : await statValidatedFile(validated, relPath));
  }
}

interface CollectedArtifact {
  files: CollectedArtifactFile[];
  specRealPath: string;
}

/**
 * 单次枚举 spec + tickets（read=true 时经文件句柄携带同批 Buffer）。
 * 共享校验：spec/tickets 存在性与类型、符号链接（含父组件与打开时交换）、
 * 越界、manifest 路径唯一、**Spec 兼作唯一 Ticket 拒绝**（按文件身份 dev+ino
 * 判定，硬链接别名同样不算独立 Ticket）。
 */
async function collectArtifact(
  root: string,
  request: Extract<ProductSpecRequest, { deliveryMode: 'local' }>,
  read: boolean,
  hooks?: ArtifactReadHooks,
): Promise<CollectedArtifact> {
  const specValidated = await assertRealInsideRoot(root, resolve(root, request.specPath), 'Spec 文件', hooks?.afterResolve)
    .catch((error) => {
      if (error instanceof ArtifactDigestError && error.code === 'unreadable') {
        throw new ArtifactDigestError('spec_missing', `Spec 文件缺失: ${request.specPath}`);
      }
      throw error;
    });
  const specStat = await stat(specValidated.realPath);
  if (!specStat.isFile()) {
    throw new ArtifactDigestError('spec_not_file', `Spec 路径不是文件: ${request.specPath}`);
  }
  await hooks?.afterValidate?.(toPosix(request.specPath));
  const specEntry = read
    ? await openValidatedFile(specValidated, toPosix(request.specPath), hooks)
    : await statValidatedFile(specValidated, toPosix(request.specPath));
  const files: CollectedArtifactFile[] = [specEntry];

  const ticketsValidated = await assertRealInsideRoot(root, resolve(root, request.ticketsPath), 'Tickets 目录', hooks?.afterResolve)
    .catch((error) => {
      if (error instanceof ArtifactDigestError && error.code === 'unreadable') {
        throw new ArtifactDigestError('tickets_missing', `Tickets 目录缺失: ${request.ticketsPath}`);
      }
      throw error;
    });
  const ticketsStat = await stat(ticketsValidated.realPath);
  if (!ticketsStat.isDirectory()) {
    throw new ArtifactDigestError('tickets_not_directory', `Tickets 路径不是目录: ${request.ticketsPath}`);
  }
  await collectMarkdownFiles(
    root, ticketsValidated.realPath, toPosix(request.ticketsPath),
    { dev: specEntry.dev, ino: specEntry.ino }, read, files, hooks,
  );

  // Spec 兼作唯一 Ticket：按文件身份（realpath + dev/ino）判定——硬链接别名、
  // 路径字符串差异都不算独立 Ticket。
  const distinct = files.slice(1).some(
    (file) => file.realPath !== specEntry.realPath && (file.dev !== specEntry.dev || file.ino !== specEntry.ino),
  );
  if (!distinct) {
    throw new ArtifactDigestError(
      'tickets_empty',
      `Tickets 目录内没有任何与 Spec 文件身份不同的 .md 文件（Spec/硬链接别名不得兼作唯一 Ticket）: ${request.ticketsPath}`,
    );
  }
  assertUniqueManifestPaths(files);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, specRealPath: specEntry.realPath };
}

function manifestDigest(files: CollectedArtifactFile[]): { digest: string; files: ArtifactFileDigest[] } {
  const manifest = files.map((file) => ({
    path: file.path,
    sha256: sha256Hex(file.buffer ?? ''),
  }));
  // 无歧义编码：规范 JSON 数组 [algorithm, [relativePath, sha256], ...]。
  // 换行分隔的「sha256  path」清单可被含换行的文件名构造碰撞；JSON 结构化
  // 编码不存在该歧义。
  const canonical = JSON.stringify([
    DIGEST_ALGORITHM,
    ...manifest.map((file) => [file.path, file.sha256] as const),
  ]);
  return { digest: sha256Hex(canonical), files: manifest };
}

export async function computeLocalArtifactDigest(
  workspaceDir: string,
  request: Extract<ProductSpecRequest, { deliveryMode: 'local' }>,
): Promise<LocalArtifactDigest> {
  const root = await realpath(workspaceDir).catch(() => {
    throw new ArtifactDigestError('unreadable', `工作区目录无法读取: ${workspaceDir}`);
  });
  // 与 readLocalArtifactSnapshot 同一受控读取（句柄 + 读前/读后身份比对）+
  // 第二轮文件集身份复核：G2/G3 未来使用本函数时获得同样的稳定性保证，
  // 不把不稳定读当已核验摘要。
  const first = await collectArtifact(root, request, true);
  const second = await collectArtifact(root, request, false);
  assertStableArtifact(first.files, second.files);
  const { digest, files } = manifestDigest(first.files);
  return {
    algorithm: DIGEST_ALGORITHM,
    digest,
    files,
    content_sources: [
      { kind: 'local', path: toPosix(request.specPath) },
      { kind: 'local', path: toPosix(request.ticketsPath) },
    ],
  };
}

/** 第二轮（只列身份）与第一轮逐 manifest 路径比对：任何差异即读取后漂移。 */
function assertStableArtifact(first: CollectedArtifactFile[], second: CollectedArtifactFile[]): void {
  const firstMap = new Map(first.map((file) => [file.path, identityOf(file)]));
  const secondMap = new Map(second.map((file) => [file.path, identityOf(file)]));
  if (firstMap.size !== secondMap.size || [...firstMap.keys()].some((path) => firstMap.get(path) !== secondMap.get(path))) {
    throw new ArtifactDigestError(
      'changed_during_read',
      '制品文件集或内容在读取过程中发生变化（摘要与正文可能来自不同版本），失败关闭；请重试。',
    );
  }
}

/**
 * 单次受控读取（W5 二轮 P0）：一次枚举同时产出 manifest 摘要与**同批**正文，
 * 读后重列文件集并逐文件复核身份（size/mtimeMs/真实路径），任何差异 ⇒
 * `changed_during_read` 失败关闭。G1 与提交点只消费这一次结果，摘要与正文
 * 不可能来自不同版本。
 *
 * `hooks.afterRead` 仅供测试注入「读取过程中 A→B」时序（注入只会让读取更
 * 容易失败，不构成运行时开关）。
 */
export async function readLocalArtifactSnapshot(
  workspaceDir: string,
  request: Extract<ProductSpecRequest, { deliveryMode: 'local' }>,
  hooks?: { afterRead?: (paths: readonly string[]) => Promise<void> } & ArtifactReadHooks,
): Promise<LocalArtifactSnapshot> {
  const root = await realpath(workspaceDir).catch(() => {
    throw new ArtifactDigestError('unreadable', `工作区目录无法读取: ${workspaceDir}`);
  });
  const first = await collectArtifact(root, request, true, hooks);
  if (hooks?.afterRead) {
    await hooks.afterRead(first.files.map((file) => file.path));
  }
  // 稳定性复核：重列文件集（不读内容）并逐 manifest 路径比对完整身份指纹。
  const second = await collectArtifact(root, request, false);
  assertStableArtifact(first.files, second.files);
  const { digest, files } = manifestDigest(first.files);
  return {
    digest: {
      algorithm: DIGEST_ALGORITHM,
      digest,
      files,
      content_sources: [
        { kind: 'local', path: toPosix(request.specPath) },
        { kind: 'local', path: toPosix(request.ticketsPath) },
      ],
    },
    texts: first.files.map((file) => (file.buffer ?? Buffer.alloc(0)).toString('utf8')),
  };
}

/**
 * 飞书模式的完整回读能力探测（U-3）尚未核验：只能读回 Markdown 导出不足以
 * 覆盖 block 树、顺序与嵌入资源，正式审批摘要保持 blocked（13 号 C2）。
 * 能力探测与 mock 属后续批次；这里不做假成功桩。
 */
export function assertLarkDigestCapability(): never {
  throw new ArtifactDigestError(
    'lark_digest_blocked',
    '飞书文档完整 block 树/资源回读能力尚未核验（U-3），不能据此计算正式审批摘要：审批与编码保持 blocked',
  );
}

// ---- 架构制品（T-020）：单一设计文档的受控读取与摘要 --------------------------

export interface ArchitectureArtifactSnapshot {
  digest: LocalArtifactDigest;
  texts: string[];
}

/**
 * 本地请求的 kind↔request 关联收窄：`artifact_kind` 与 request 形状分属两个
 * 判别维度，TypeScript 无法联合收窄——以 request 实际字段（`designPath` in）
 * 判定制品形态，产品/架构分别得到各自精确的本地请求类型（运行时真实判定，
 * 不是 cast）。飞书交付在此显式抛 blocked（U-3）。
 */
export function localArtifactInputOf(flow: Pick<ProductSpecFlow, 'request' | 'artifact_kind'>):
  | { kind: 'prd'; request: LocalProductSpecRequest }
  | { kind: 'architecture'; request: LocalArchitectureRequest } {
  const request = flow.request;
  if (request.deliveryMode !== 'local') {
    throw new ArtifactDigestError(
      'lark_digest_blocked',
      '飞书文档完整 block 树/资源回读能力尚未核验（U-3），本地受控读取不适用',
    );
  }
  if ('designPath' in request) return { kind: 'architecture', request };
  return { kind: 'prd', request };
}

async function readArchitectureArtifact(
  workspaceDir: string,
  request: LocalArchitectureRequest,
  read: boolean,
  hooks?: ArtifactReadHooks,
): Promise<CollectedArtifactFile> {
  const root = await realpath(workspaceDir).catch(() => {
    throw new ArtifactDigestError('unreadable', `工作区目录无法读取: ${workspaceDir}`);
  });
  const validated = await assertRealInsideRoot(root, resolve(root, request.designPath), '架构设计文档', hooks?.afterResolve)
    .catch((error) => {
      if (error instanceof ArtifactDigestError && error.code === 'unreadable') {
        throw new ArtifactDigestError('spec_missing', `架构设计文档缺失: ${request.designPath}`);
      }
      throw error;
    });
  const info = await stat(validated.realPath);
  if (!info.isFile()) {
    throw new ArtifactDigestError('spec_not_file', `架构设计路径不是文件: ${request.designPath}`);
  }
  await hooks?.afterValidate?.(toPosix(request.designPath));
  return read
    ? await openValidatedFile(validated, toPosix(request.designPath), hooks)
    : await statValidatedFile(validated, toPosix(request.designPath));
}

/**
 * 架构制品摘要：与产品制品同一套受控读取（三方身份绑定、读前/读后纳秒比对、
 * 第二轮身份复核）与同一 canonical-sha256-v1 编码；架构是单一设计文档，
 * 不适用「Spec 不得兼作唯一 Ticket」的产品制品规则。
 */
export async function readArchitectureArtifactSnapshot(
  workspaceDir: string,
  request: LocalArchitectureRequest,
  hooks?: { afterRead?: (paths: readonly string[]) => Promise<void> } & ArtifactReadHooks,
): Promise<ArchitectureArtifactSnapshot> {
  const first = await readArchitectureArtifact(workspaceDir, request, true, hooks);
  if (hooks?.afterRead) await hooks.afterRead([first.path]);
  const second = await readArchitectureArtifact(workspaceDir, request, false);
  assertStableArtifact([first], [second]);
  const { digest, files } = manifestDigest([first]);
  return {
    digest: {
      algorithm: DIGEST_ALGORITHM,
      digest,
      files,
      content_sources: [{ kind: 'local', path: toPosix(request.designPath) }],
    },
    texts: [(first.buffer ?? Buffer.alloc(0)).toString('utf8')],
  };
}

export async function computeArchitectureArtifactDigest(
  workspaceDir: string,
  request: LocalArchitectureRequest,
): Promise<LocalArtifactDigest> {
  const snapshot = await readArchitectureArtifactSnapshot(workspaceDir, request);
  return snapshot.digest;
}

export type ApprovalGateRejection = {
  ok: false;
  level: 'warning' | 'error';
  message: string;
};

/**
 * G1：审批动作前的回读校验（失败关闭）。产品（prd）与架构（architecture）
 * 制品共用此门禁：摘要比对与正文引用核验消费**同一次受控读取**
 * （readLocalArtifactSnapshot / readArchitectureArtifactSnapshot），不存在
 * 「摘要读 A、正文读 B」的窗口。正文出现 `[[kb:` 候选时逐个严格解析：畸形/
 * 未闭合/超限令牌一律失败关闭，不得静默忽略后放行空引用方案。
 */
export async function verifyApprovableArtifact(options: {
  flow: Pick<
    ProductSpecFlow,
    'request' | 'content_digest' | 'knowledge_refs' | 'knowledge_state' | 'artifact_kind' | 'upstream'
  >;
  workspaceDir: string | undefined;
  /** 服务端引用核验（含台账与任务/会话/作用域绑定）；引用存在时必须提供，否则失败关闭。架构制品的核验绑定沿用上游 PRD 的任务/会话（由调用方闭包决定）。 */
  verifyKnowledgeCitations?: (input: {
    artifactTexts: readonly string[];
    declaredRefs: NonNullable<ProductSpecFlow['knowledge_refs']>;
  }) => { ok: true } | { ok: false; reason: string } | Promise<{ ok: true } | { ok: false; reason: string }>;
  /** 测试注入：读取与稳定性复核之间触发「读取过程中变化」时序。 */
  artifactReadHook?: () => Promise<void>;
}): Promise<{ ok: true } | ApprovalGateRejection> {
  const { flow, workspaceDir } = options;
  const kind = flow.artifact_kind ?? 'prd';
  if (kind === 'architecture' && !flow.upstream) {
    return {
      ok: false,
      level: 'error',
      message: '这份架构设计没有绑定上游产品方案（服务端交接缺失），不能确认。',
    };
  }
  if (flow.request.deliveryMode === 'lark-doc') {
    return {
      ok: false,
      level: 'error',
      message: '飞书文档完整回读能力尚未核验（U-3），这份方案的审批与编码保持 blocked。',
    };
  }
  if (flow.content_digest == null) {
    return {
      ok: false,
      level: 'warning',
      message: '这份方案没有绑定内容摘要（旧记录或摘要计算未完成），不能确认。请重新生成后再审批。',
    };
  }
  if (flow.knowledge_state === 'degraded') {
    return {
      ok: false,
      level: 'warning',
      message: '方案生成时知识基准不可用（兼容性分析 incomplete）。需要你明确确认例外后才能审批；例外确认通道尚未开放。',
    };
  }
  if (flow.knowledge_state === 'no_current_objects') {
    return {
      ok: false,
      level: 'warning',
      message: '方案生成时知识库没有任何可作为现行事实的对象（已有项目、检索/读回后现行清空；生产环境预期：受保护 current 锚与部署核验未配置）。PRD 不得引用现行事实；例外确认通道尚未开放，普通确认被阻止。',
    };
  }
  if (!workspaceDir) {
    return {
      ok: false,
      level: 'error',
      message: '找不到方案对应的会话工作区，无法回读制品文件，确认被拒绝。',
    };
  }
  const input = localArtifactInputOf(flow);
  let snapshot: LocalArtifactSnapshot | ArchitectureArtifactSnapshot;
  try {
    const hooks = {
      afterRead: options.artifactReadHook ? async () => options.artifactReadHook!() : undefined,
    };
    snapshot = input.kind === 'architecture'
      ? await readArchitectureArtifactSnapshot(workspaceDir, input.request, hooks)
      : await readLocalArtifactSnapshot(workspaceDir, input.request, hooks);
  } catch (error) {
    const detail = error instanceof ArtifactDigestError
      ? error.message
      : `回读失败: ${(error as Error).message}`;
    return {
      ok: false,
      level: 'error',
      message: `方案文件无法完整回读，确认被拒绝（${detail}）。`,
    };
  }
  if (snapshot.digest.digest !== flow.content_digest) {
    return {
      ok: false,
      level: 'warning',
      message: '方案文件在提交后发生了变化，请重新审阅最新内容后再确认。',
    };
  }
  // 正文令牌严格扫描：extractKnowledgeCitations 逐个核对所有 [[kb: 候选，
  // 畸形/未闭合/超限令牌直接抛错——不合法候选不得被静默忽略后放行。
  let citationCount = 0;
  for (const text of snapshot.texts) {
    let parsed;
    try {
      parsed = extractKnowledgeCitations(text);
    } catch (error) {
      return {
        ok: false,
        level: 'warning',
        message: `方案正文包含畸形的知识引用令牌，确认被拒绝：${(error as Error).message}`,
      };
    }
    citationCount += parsed.length;
  }
  const declaredRefs = flow.knowledge_refs ?? [];
  if (citationCount > 0 || declaredRefs.length > 0) {
    if (!options.verifyKnowledgeCitations) {
      return {
        ok: false,
        level: 'error',
        message: '方案包含知识引用（或声明了引用），但服务端引用核验不可用，确认被拒绝。',
      };
    }
    const verified = await options.verifyKnowledgeCitations({ artifactTexts: snapshot.texts, declaredRefs });
    if (!verified.ok) {
      return { ok: false, level: 'warning', message: `知识引用核验未通过：${verified.reason}` };
    }
  }
  return { ok: true };
}

/** G2/G3 前置：已批准且摘要已绑定的制品才可进入授权/编码；旧 approved 记录无摘要一律拒绝。 */
export function assertArtifactAuthorizable(flow: Pick<ProductSpecFlow, 'status' | 'content_digest'>): void {
  if (flow.status !== 'approved') {
    throw new Error('制品尚未获得审批，不能进入编码授权。');
  }
  if (flow.content_digest == null) {
    throw new Error('旧审批记录没有内容摘要，不得默认补出有效摘要；需重新生成方案并审批。');
  }
}

/**
 * G2/G3 异步完整回读守卫（W5 返修新增）：批准后进入授权/编码前，完整重算
 * 制品摘要并与批准时绑定的摘要比对——「approved + 非空摘要」不再足够，批准后
 * 的任何文件改动都会使授权失败关闭（13 号 C2）。
 *
 * 注意：本守卫**尚未接入正式 CodingAuthorization**——真实编码入口在完整授权链
 * 与 CLI 读写 canary（W6）通过前保持 blocked；这里只交付本地接口与负例。
 * 无摘要/未批准/工作区缺失/回读失败/漂移一律 throw，不返回部分结果。
 */
export async function assertArtifactStillMatchesApproval(options: {
  flow: Pick<ProductSpecFlow, 'status' | 'content_digest' | 'request' | 'artifact_kind'>;
  workspaceDir: string | undefined;
}): Promise<void> {
  const { flow, workspaceDir } = options;
  if (flow.status !== 'approved') {
    throw new Error('制品尚未获得审批，不能进入编码授权。');
  }
  if (flow.content_digest == null) {
    throw new Error('旧审批记录没有内容摘要，不得默认补出有效摘要；需重新生成方案并审批。');
  }
  if (flow.request.deliveryMode === 'lark-doc') {
    throw new Error('飞书文档完整回读能力尚未核验（U-3），授权与编码保持 blocked。');
  }
  if (!workspaceDir) {
    throw new Error('找不到方案对应的会话工作区，无法回读制品文件，授权失败关闭。');
  }
  let recomputed: LocalArtifactDigest;
  try {
    const input = localArtifactInputOf(flow);
    recomputed = input.kind === 'architecture'
      ? await computeArchitectureArtifactDigest(workspaceDir, input.request)
      : await computeLocalArtifactDigest(workspaceDir, input.request);
  } catch (error) {
    const detail = error instanceof ArtifactDigestError
      ? error.message
      : `回读失败: ${(error as Error).message}`;
    throw new Error(`方案文件无法完整回读，授权失败关闭（${detail}）。`);
  }
  if (recomputed.digest !== flow.content_digest) {
    throw new Error('方案文件在批准后发生了变化，旧摘要已失效；需重新生成方案并审批。');
  }
}
