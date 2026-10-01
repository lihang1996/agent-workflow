/**
 * A04/B3a：受保护 zcode runtime 的文件 inventory 解析、fixture 快照比对与
 * 固定路径生产 loader。这只是文件密封/清单证明（file sealing / manifest
 * proof）：它不证明 import 解析边界，也不构成任何 SDK 认证、lease、runner
 * 或 production registration。
 */
import { createHash } from 'node:crypto';
import { type Dir, closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { CONTROL_ROOT, assertProtectedPath, readProtectedJson } from './protected-control.js';

/** 生产路径固定，禁止 env/参数/task payload 重定向。 */
export const ZCODE_RUNTIME_ROOT = CONTROL_ROOT + '/zcode/runtime';
export const ZCODE_RUNTIME_MANIFEST_PATH = CONTROL_ROOT + '/zcode/runtime-manifest.json';

export const ZCODE_RUNTIME_INVENTORY_LIMITS = Object.freeze({
    maxFiles: 20000,
    maxDirectories: 20000,
    maxDepth: 32,
    maxFileBytes: 268435456,
    maxTotalBytes: 1073741824,
    maxPathBytes: 1024,
    maxRevisionLength: 128,
});

export type ZcodeRuntimeInventoryCode =
    | 'manifest-shape'
    | 'manifest-path'
    | 'manifest-revision'
    | 'manifest-hash'
    | 'manifest-bytes'
    | 'manifest-budget'
    | 'manifest-directories'
    | 'manifest-entries'
    | 'snapshot-shape'
    | 'snapshot-ownership'
    | 'snapshot-mode'
    | 'snapshot-nlink'
    | 'snapshot-size'
    | 'snapshot-hash'
    | 'snapshot-missing'
    | 'snapshot-extra'
    | 'protected-read'
    | 'runtime-changed';

const MESSAGES: Record<ZcodeRuntimeInventoryCode, string> = Object.freeze({
    'manifest-shape': 'zcode runtime inventory manifest has an invalid shape',
    'manifest-path': 'zcode runtime inventory manifest contains an invalid path',
    'manifest-revision': 'zcode runtime inventory manifest contains an invalid revision',
    'manifest-hash': 'zcode runtime inventory manifest contains an invalid digest',
    'manifest-bytes': 'zcode runtime inventory manifest contains invalid byte counts',
    'manifest-budget': 'zcode runtime inventory manifest exceeds fixed limits',
    'manifest-directories': 'zcode runtime inventory manifest directory set is incomplete or conflicting',
    'manifest-entries': 'zcode runtime inventory manifest entries are missing or conflicting',
    'snapshot-shape': 'zcode runtime inventory snapshot has an invalid shape',
    'snapshot-ownership': 'zcode runtime inventory snapshot contains non-root ownership',
    'snapshot-mode': 'zcode runtime inventory snapshot contains an unsafe file mode',
    'snapshot-nlink': 'zcode runtime inventory snapshot contains a linked file',
    'snapshot-size': 'zcode runtime inventory snapshot byte count mismatch',
    'snapshot-hash': 'zcode runtime inventory snapshot digest mismatch',
    'snapshot-missing': 'zcode runtime inventory snapshot is missing manifest entries',
    'snapshot-extra': 'zcode runtime inventory snapshot contains unexpected entries',
    'protected-read': 'protected zcode runtime read failed',
    'runtime-changed': 'protected zcode runtime changed during verification',
});

export class ZcodeRuntimeInventoryError extends Error {
    readonly code: ZcodeRuntimeInventoryCode;
    /** message 只能来自内部固定映射：构造器不接受调用方提供的文本。 */
    constructor(code: ZcodeRuntimeInventoryCode) {
        super(MESSAGES[code]);
        this.name = 'ZcodeRuntimeInventoryError';
        this.code = code;
    }
}

function fail(code: ZcodeRuntimeInventoryCode): never {
    throw new ZcodeRuntimeInventoryError(code);
}

/** path 相对 runtime root、POSIX 段、非空、UTF-8 字节受限，绝不 normalize/truncate。 */
function checkRelativePath(raw: unknown): string {
    if (typeof raw !== 'string' || raw.length === 0)
        fail('manifest-path');
    if (raw.startsWith('/') || isAbsolute(raw) || raw.includes('\\'))
        fail('manifest-path');
    for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c < 0x20 || c === 0x7f)
            fail('manifest-path');
    }
    if (raw.includes('\0') || Buffer.byteLength(raw, 'utf8') > ZCODE_RUNTIME_INVENTORY_LIMITS.maxPathBytes)
        fail('manifest-path');
    const segments = raw.split('/');
    if (segments.length > ZCODE_RUNTIME_INVENTORY_LIMITS.maxDepth)
        fail('manifest-path');
    for (const segment of segments)
        if (segment.length === 0 || segment === '.' || segment === '..')
            fail('manifest-path');
    return raw;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkPlainString(value: unknown): string {
    if (typeof value !== 'string')
        fail('manifest-shape');
    return value;
}

/** 严格对象字段：多余（含不可枚举）或缺失/原型继承键直接拒绝，绝不默默忽略 unknown 输入。 */
function checkExactKeys(value: Record<string, unknown>, keys: readonly string[], code: ZcodeRuntimeInventoryCode): void {
    const actual = Object.getOwnPropertyNames(value);
    if (actual.length !== keys.length)
        fail(code);
    for (const key of keys)
        if (!Object.hasOwn(value, key))
            fail(code);
}

function isLowercaseHex64(value: unknown): value is string {
    return typeof value === 'string' && value.length === 64 && /^[0-9a-f]{64}$/.test(value);
}

export interface ZcodeRuntimeInventoryFile {
    readonly path: string;
    readonly sha256: string;
    readonly bytes: number;
}

export interface ZcodeRuntimeInventoryManifest {
    readonly schema: 'zcode-runtime-inventory/1';
    readonly revision: string;
    readonly entries: Readonly<Record<'node' | 'loader' | 'bootstrap' | 'cli' | 'builtin', string>>;
    readonly directories: readonly string[];
    readonly files: readonly ZcodeRuntimeInventoryFile[];
}

const ENTRY_KEYS = ['bootstrap', 'builtin', 'cli', 'loader', 'node'] as const;
type EntryKey = (typeof ENTRY_KEYS)[number];

function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === 'object')
        for (const key of Object.keys(value as Record<string, unknown>))
            deepFreeze((value as Record<string, unknown>)[key]);
    return Object.freeze(value);
}

function parseRevision(raw: unknown): string {
    if (typeof raw !== 'string')
        fail('manifest-revision');
    const revision = raw;
    if (revision.length === 0 || revision.length > ZCODE_RUNTIME_INVENTORY_LIMITS.maxRevisionLength)
        fail('manifest-revision');
    if (!/^[A-Za-z0-9._-]+$/.test(revision))
        fail('manifest-revision');
    return revision;
}

/** 重新构造 canonical manifest：数组按路径排序、深度冻结、不引用调用者对象。 */
export function parseZcodeRuntimeInventory(raw: unknown): ZcodeRuntimeInventoryManifest {
    if (!isPlainObject(raw))
        fail('manifest-shape');
    checkExactKeys(raw, ['directories', 'entries', 'files', 'revision', 'schema'], 'manifest-shape');
    const schema = checkPlainString(raw.schema);
    if (schema !== 'zcode-runtime-inventory/1')
        fail('manifest-shape');
    const revision = parseRevision(raw.revision);
    if (!isPlainObject(raw.entries))
        fail('manifest-shape');
    checkExactKeys(raw.entries, ENTRY_KEYS, 'manifest-shape');
    const entryPaths = new Map<string, EntryKey>();
    const entryValues = {} as Record<EntryKey, string>;
    for (const key of ENTRY_KEYS) {
        const target = checkRelativePath(raw.entries[key]);
        if (entryPaths.has(target))
            fail('manifest-entries');
        entryPaths.set(target, key);
        entryValues[key] = target;
    }
    if (!Array.isArray(raw.files) || raw.files.length === 0)
        fail('manifest-shape');
    if (raw.files.length > ZCODE_RUNTIME_INVENTORY_LIMITS.maxFiles)
        fail('manifest-budget');
    const filePaths = new Set<string>();
    const files: ZcodeRuntimeInventoryFile[] = [];
    let totalBytes = 0;
    for (const candidate of raw.files) {
        if (!isPlainObject(candidate))
            fail('manifest-shape');
        checkExactKeys(candidate, ['bytes', 'path', 'sha256'], 'manifest-shape');
        const path = checkRelativePath(candidate.path);
        if (filePaths.has(path))
            fail('manifest-budget');
        filePaths.add(path);
        const sha256 = candidate.sha256;
        if (typeof sha256 !== 'string' || !isLowercaseHex64(sha256))
            fail('manifest-hash');
        const bytes = candidate.bytes;
        if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0)
            fail('manifest-bytes');
        if (bytes > ZCODE_RUNTIME_INVENTORY_LIMITS.maxFileBytes)
            fail('manifest-budget');
        totalBytes += bytes;
        if (!Number.isSafeInteger(totalBytes) || totalBytes > ZCODE_RUNTIME_INVENTORY_LIMITS.maxTotalBytes)
            fail('manifest-budget');
        files.push({ path, sha256, bytes });
    }
    for (const target of entryPaths.keys())
        if (!filePaths.has(target))
            fail('manifest-entries');
    if (!Array.isArray(raw.directories))
        fail('manifest-shape');
    if (raw.directories.length > ZCODE_RUNTIME_INVENTORY_LIMITS.maxDirectories)
        fail('manifest-budget');
    const directories = new Set<string>();
    for (const candidate of raw.directories) {
        const path = checkRelativePath(candidate);
        if (directories.has(path) || filePaths.has(path))
            fail('manifest-directories');
        directories.add(path);
    }
    const requiredDirectories = new Set<string>();
    const requireParents = (path: string) => {
        for (let parent = dirname(path); parent !== '.' && parent !== '/'; parent = dirname(parent)) {
            if (filePaths.has(parent))
                fail('manifest-directories');
            requiredDirectories.add(parent);
        }
    };
    for (const path of filePaths) requireParents(path);
    for (const path of directories) requireParents(path);
    for (const required of requiredDirectories)
        if (!directories.has(required))
            fail('manifest-directories');
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return deepFreeze({
        schema: 'zcode-runtime-inventory/1' as const,
        revision,
        entries: Object.freeze({ ...entryValues }),
        directories: Object.freeze([...directories].sort()),
        files: Object.freeze(files.map((file) => Object.freeze({ ...file }))),
    });
}

/** 稳定 canonical JSON：按固定键序重建对象后 JSON.stringify，与原输入顺序无关。 */
function canonicalManifestJson(manifest: ZcodeRuntimeInventoryManifest): string {
    return JSON.stringify({
        directories: manifest.directories,
        entries: Object.fromEntries(ENTRY_KEYS.map((key) => [key, manifest.entries[key]])),
        files: manifest.files.map((file) => ({ bytes: file.bytes, path: file.path, sha256: file.sha256 })),
        revision: manifest.revision,
        schema: manifest.schema,
    });
}

export function zcodeRuntimeManifestDigest(manifest: ZcodeRuntimeInventoryManifest): string {
    return createHash('sha256').update(canonicalManifestJson(manifest), 'utf8').digest('hex');
}

interface SnapshotDirectory { path: string; uid: number; mode: number }
interface SnapshotFile { path: string; uid: number; mode: number; nlink: number; bytes: number; sha256: string }
export interface ZcodeRuntimeInventorySnapshot {
    readonly directories: readonly SnapshotDirectory[];
    readonly files: readonly SnapshotFile[];
}

/**
 * 显式 fixture 比对。snapshot 只表达调用方已收集的数据，绝不声称已检查
 * 实际文件系统，也不能生成任何生产 receipt。
 */
export function verifyZcodeRuntimeInventorySnapshot(manifest: unknown, snapshot: unknown): {
    readonly kind: 'inventory-snapshot-matched';
    readonly manifestDigest: string;
    readonly fileCount: number;
    readonly totalBytes: number;
} {
    const canonical = parseZcodeRuntimeInventory(manifest);
    if (!isPlainObject(snapshot) || !Array.isArray(snapshot.directories) || !Array.isArray(snapshot.files))
        fail('snapshot-shape');
    checkExactKeys(snapshot, ['directories', 'files'], 'snapshot-shape');
    if (snapshot.directories.length > ZCODE_RUNTIME_INVENTORY_LIMITS.maxDirectories
        || snapshot.files.length > ZCODE_RUNTIME_INVENTORY_LIMITS.maxFiles)
        fail('snapshot-shape');
    const snapDirs = new Map<string, SnapshotDirectory>();
    for (const candidate of snapshot.directories) {
        if (!isPlainObject(candidate))
            fail('snapshot-shape');
        checkExactKeys(candidate, ['mode', 'path', 'uid'], 'snapshot-shape');
        const path = checkRelativePath(candidate.path);
        if (typeof candidate.uid !== 'number' || !Number.isSafeInteger(candidate.uid))
            fail('snapshot-shape');
        if (typeof candidate.mode !== 'number' || !Number.isSafeInteger(candidate.mode) || candidate.mode < 0 || candidate.mode > 0o177777)
            fail('snapshot-shape');
        if (snapDirs.has(path))
            fail('snapshot-shape');
        snapDirs.set(path, { path, uid: candidate.uid, mode: candidate.mode });
    }
    const snapFiles = new Map<string, SnapshotFile>();
    let totalBytes = 0;
    for (const candidate of snapshot.files) {
        if (!isPlainObject(candidate))
            fail('snapshot-shape');
        checkExactKeys(candidate, ['bytes', 'mode', 'nlink', 'path', 'sha256', 'uid'], 'snapshot-shape');
        const path = checkRelativePath(candidate.path);
        for (const key of ['uid', 'mode', 'nlink', 'bytes'] as const) {
            if (typeof candidate[key] !== 'number' || !Number.isSafeInteger(candidate[key]) || (candidate[key] as number) < 0)
                fail('snapshot-shape');
        }
        if ((candidate.mode as number) > 0o177777)
            fail('snapshot-shape');
        if (!isLowercaseHex64(candidate.sha256))
            fail('snapshot-shape');
        if (snapFiles.has(path) || snapDirs.has(path))
            fail('snapshot-shape');
        snapFiles.set(path, { path, uid: candidate.uid as number, mode: candidate.mode as number, nlink: candidate.nlink as number, bytes: candidate.bytes as number, sha256: candidate.sha256 as string });
        totalBytes += candidate.bytes as number;
        if (!Number.isSafeInteger(totalBytes) || totalBytes > ZCODE_RUNTIME_INVENTORY_LIMITS.maxTotalBytes)
            fail('snapshot-shape');
    }
    for (const dir of snapDirs.values()) {
        if (dir.uid !== 0)
            fail('snapshot-ownership');
        if ((dir.mode & 0o022) !== 0 || (dir.mode & 0o6000) !== 0)
            fail('snapshot-mode');
    }
    const nodePath = canonical.entries.node;
    for (const file of snapFiles.values()) {
        if (file.uid !== 0)
            fail('snapshot-ownership');
        if ((file.mode & 0o022) !== 0 || (file.mode & 0o6000) !== 0)
            fail('snapshot-mode');
        if (file.nlink !== 1)
            fail('snapshot-nlink');
        if (file.bytes > ZCODE_RUNTIME_INVENTORY_LIMITS.maxFileBytes)
            fail('snapshot-shape');
        if (file.path === nodePath && (file.mode & 0o100) === 0)
            fail('snapshot-mode');
    }
    const manifestDirSet = new Set(canonical.directories);
    const manifestFileSet = new Set(canonical.files.map((file) => file.path));
    for (const path of manifestDirSet)
        if (!snapDirs.has(path))
            fail('snapshot-missing');
    for (const path of snapDirs.keys())
        if (!manifestDirSet.has(path))
            fail('snapshot-extra');
    for (const file of canonical.files) {
        const observed = snapFiles.get(file.path);
        if (observed === undefined)
            fail('snapshot-missing');
        if (observed.bytes !== file.bytes)
            fail('snapshot-size');
        if (observed.sha256 !== file.sha256)
            fail('snapshot-hash');
    }
    for (const path of snapFiles.keys())
        if (!manifestFileSet.has(path))
            fail('snapshot-extra');
    return Object.freeze({
        kind: 'inventory-snapshot-matched' as const,
        manifestDigest: zcodeRuntimeManifestDigest(canonical),
        fileCount: canonical.files.length,
        totalBytes,
    });
}

interface StatLike {
    dev: number; ino: number; uid: number; gid: number; mode: number; nlink: number;
    size: number; mtimeMs: number; ctimeMs: number;
    isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean;
}

function sameIdentity(a: StatLike, b: StatLike): boolean {
    return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid
        && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size
        && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function statGuard(path: string): StatLike {
    try {
        return lstatSync(path) as unknown as StatLike;
    }
    catch {
        return fail('protected-read');
    }
}

/** O_NOFOLLOW 安全读取：读前预算/身份检查、64KiB 增量 hash、fd 必然关闭（关闭异常固定失败）。 */
function readAndHash(absPath: string, budgetRemaining: number): { sha256: string; bytes: number } {
    const before = statGuard(absPath);
    if (before.size > ZCODE_RUNTIME_INVENTORY_LIMITS.maxFileBytes || before.size > budgetRemaining)
        fail('manifest-budget');
    let fd: number | undefined;
    try {
        fd = openSync(absPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        const opened = fstatSync(fd) as unknown as StatLike;
        if (!sameIdentity(before, opened))
            fail('runtime-changed');
        const hash = createHash('sha256');
        const buffer = Buffer.alloc(65536);
        let bytes = 0;
        for (;;) {
            const read = readSync(fd, buffer, 0, buffer.length, null);
            if (read === 0)
                break;
            bytes += read;
            if (bytes > ZCODE_RUNTIME_INVENTORY_LIMITS.maxFileBytes || bytes > budgetRemaining)
                fail('manifest-budget');
            hash.update(buffer.subarray(0, read));
        }
        const after = fstatSync(fd) as unknown as StatLike;
        if (!sameIdentity(opened, after) || after.size !== bytes)
            fail('runtime-changed');
        const named = statGuard(absPath);
        if (!sameIdentity(named, opened))
            fail('runtime-changed');
        const result = { sha256: hash.digest('hex'), bytes };
        return result;
    }
    catch (error) {
        if (error instanceof ZcodeRuntimeInventoryError)
            throw error;
        fail('protected-read');
    }
    finally {
        // 单一关闭职责：关闭前先摘除待关闭状态（fd=undefined），close 异常
        // 固定失败；即使 body 已 return 也由该固定错误失败关闭，成功路径
        // 绝不吞掉唯一的 close 失败，也绝不重试第二次 close。
        if (fd !== undefined) {
            const pending = fd;
            fd = undefined;
            try { closeSync(pending); }
            catch { fail('protected-read'); }
        }
    }
    // 不可达：try 必然 return，catch 必然 throw；TS 对含 finally 的 never 分析不完整。
    return fail('protected-read');
}

export interface ProtectedZcodeRuntimeInventoryReceipt {
    readonly kind: 'protected-runtime-inventory-verified';
    readonly root: string;
    readonly manifestDigest: string;
    readonly fileCount: number;
    readonly totalBytes: number;
    readonly entries: Readonly<Record<EntryKey, string>>;
}

const verifiedReceipts = new WeakSet<object>();

export function isProtectedZcodeRuntimeInventory(value: unknown): value is ProtectedZcodeRuntimeInventoryReceipt {
    return typeof value === 'object' && value !== null && verifiedReceipts.has(value);
}

/**
 * 生产固定 loader：无参数、固定路径、真实文件系统。只证明文件密封/清单
 * 一致，不证明 import 解析边界或 production registration，也没有任何跳过
 * root owner 校验或注入 fake probe 的入口。全程对扫描时保存的完整身份
 * （dev/ino/uid/gid/mode/nlink/size/mtime/ctime）做快照比对，任何阶段
 * 的漂移都失败关闭。
 */
export function loadProtectedZcodeRuntimeInventory(): ProtectedZcodeRuntimeInventoryReceipt {
    let manifestStat: StatLike;
    let canonical: ZcodeRuntimeInventoryManifest;
    let digest: string;
    try {
        assertProtectedPath(ZCODE_RUNTIME_MANIFEST_PATH);
        const before = lstatSync(ZCODE_RUNTIME_MANIFEST_PATH) as unknown as StatLike;
        if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o022) !== 0
            || (before.mode & 0o6000) !== 0 || before.uid !== 0)
            fail('protected-read');
        const raw = readProtectedJson(ZCODE_RUNTIME_MANIFEST_PATH);
        const after = lstatSync(ZCODE_RUNTIME_MANIFEST_PATH) as unknown as StatLike;
        if (!sameIdentity(before, after))
            fail('runtime-changed');
        manifestStat = before;
        canonical = parseZcodeRuntimeInventory(raw);
        digest = zcodeRuntimeManifestDigest(canonical);
    }
    catch (error) {
        if (error instanceof ZcodeRuntimeInventoryError)
            throw error;
        fail('protected-read');
    }
    const manifestFiles = new Map<string, ZcodeRuntimeInventoryFile>();
    for (const file of canonical.files) manifestFiles.set(file.path, file);
    const manifestDirs = new Set<string>(canonical.directories);
    const observedFiles = new Set<string>();
    const observedDirs = new Set<string>();
    // 完整身份快照（含 runtime root 的 '' 哨兵）与目录列举，供全部后续阶段比对。
    const fileSnapshots = new Map<string, StatLike>();
    const dirSnapshots = new Map<string, StatLike>();
    const dirListings = new Map<string, Set<string>>();
    const absOf = (rel: string) => rel === '' ? ZCODE_RUNTIME_ROOT : join(ZCODE_RUNTIME_ROOT, rel);
    // 有界目录枚举：opendirSync 逐项读取，不把未知巨型目录整体读入数组。
    const scanDirectory = (relDir: string): void => {
        const names = new Set<string>();
        let dir: Dir | undefined;
        try {
            dir = opendirSync(absOf(relDir));
            for (;;) {
                const entry = dir.readSync();
                if (entry === null)
                    break;
                if (names.has(entry.name) || names.size >= ZCODE_RUNTIME_INVENTORY_LIMITS.maxFiles + ZCODE_RUNTIME_INVENTORY_LIMITS.maxDirectories)
                    fail('runtime-changed');
                names.add(entry.name);
                const rel = relDir === '' ? entry.name : relDir + '/' + entry.name;
                checkRelativePath(rel);
                const stat = statGuard(absOf(rel));
                if (stat.uid !== 0 || (stat.mode & 0o022) !== 0 || (stat.mode & 0o6000) !== 0)
                    fail('protected-read');
                if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
                    fail('protected-read');
                if (stat.isDirectory()) {
                    if (!manifestDirs.has(rel) || observedDirs.has(rel))
                        fail('runtime-changed');
                    if (observedDirs.size >= ZCODE_RUNTIME_INVENTORY_LIMITS.maxDirectories)
                        fail('manifest-budget');
                    observedDirs.add(rel);
                    dirSnapshots.set(rel, stat);
                    scanDirectory(rel);
                }
                else {
                    if (observedFiles.size >= ZCODE_RUNTIME_INVENTORY_LIMITS.maxFiles)
                        fail('manifest-budget');
                    if (stat.nlink !== 1)
                        fail('protected-read');
                    if (!manifestFiles.has(rel))
                        fail('runtime-changed');
                    observedFiles.add(rel);
                    fileSnapshots.set(rel, stat);
                }
            }
        }
        catch (error) {
            if (error instanceof ZcodeRuntimeInventoryError)
                throw error;
            fail('protected-read');
        }
        finally {
            // 单次关闭：先摘除待关闭状态再尝试 close；close 异常固定失败，
            // 不因 body 异常重试第二次 close。
            if (dir !== undefined) {
                const pending = dir;
                dir = undefined;
                try { pending.closeSync(); }
                catch { fail('protected-read'); }
            }
        }
        dirListings.set(relDir, names);
    };
    try {
        assertProtectedPath(ZCODE_RUNTIME_ROOT);
        const rootStat = lstatSync(ZCODE_RUNTIME_ROOT) as unknown as StatLike;
        if (!rootStat.isDirectory() || rootStat.uid !== 0 || (rootStat.mode & 0o022) !== 0 || (rootStat.mode & 0o6000) !== 0)
            fail('protected-read');
        dirSnapshots.set('', rootStat);
    }
    catch (error) {
        if (error instanceof ZcodeRuntimeInventoryError)
            throw error;
        fail('protected-read');
    }
    scanDirectory('');
    // 观察集合必须精确等于 manifest：缺失的空目录、缺失文件、多余条目都拒绝。
    if (observedFiles.size !== manifestFiles.size)
        fail('runtime-changed');
    for (const path of manifestFiles.keys())
        if (!observedFiles.has(path))
            fail('runtime-changed');
    for (const path of manifestDirs)
        if (!observedDirs.has(path))
            fail('runtime-changed');
    let totalBytes = 0;
    for (const file of canonical.files) {
        const abs = absOf(file.path);
        // 哈希开始前先确认与扫描时保存的完整身份一致。
        const scanned = fileSnapshots.get(file.path);
        if (scanned === undefined || !sameIdentity(statGuard(abs), scanned))
            fail('runtime-changed');
        const result = readAndHash(abs, ZCODE_RUNTIME_INVENTORY_LIMITS.maxTotalBytes - totalBytes);
        if (result.sha256 !== file.sha256 || result.bytes !== file.bytes)
            fail('runtime-changed');
        totalBytes += result.bytes;
    }
    // 有界重列举工具：用于哈希完成后的目录复查。
    const listNamesBounded = (absDir: string): Set<string> => {
        const names = new Set<string>();
        let dir: Dir | undefined;
        try {
            dir = opendirSync(absDir);
            for (;;) {
                const entry = dir.readSync();
                if (entry === null)
                    break;
                if (names.size >= ZCODE_RUNTIME_INVENTORY_LIMITS.maxFiles + ZCODE_RUNTIME_INVENTORY_LIMITS.maxDirectories)
                    fail('manifest-budget');
                names.add(entry.name);
            }
        }
        catch (error) {
            if (error instanceof ZcodeRuntimeInventoryError)
                throw error;
            fail('protected-read');
        }
        finally {
            // 单次关闭：与 scanDirectory 相同的单一 finally 职责。
            if (dir !== undefined) {
                const pending = dir;
                dir = undefined;
                try { pending.closeSync(); }
                catch { fail('protected-read'); }
            }
        }
        return names;
    };
    // 子树读取后复查目录列举与完整身份：新增/删除/替换/漂移均拒绝。
    for (const [relDir, listing] of dirListings) {
        const current = listNamesBounded(absOf(relDir));
        if (current.size !== listing.size)
            fail('runtime-changed');
        for (const name of current)
            if (!listing.has(name))
                fail('runtime-changed');
    }
    for (const [rel, snapshot] of dirSnapshots)
        if (!sameIdentity(statGuard(absOf(rel)), snapshot))
            fail('runtime-changed');
    for (const [rel, snapshot] of fileSnapshots)
        if (!sameIdentity(statGuard(absOf(rel)), snapshot))
            fail('runtime-changed');
    // manifest 二次回读后做最终完整核验（root/manifest/全部目录与文件身份）。
    try {
        const rawAgain = readProtectedJson(ZCODE_RUNTIME_MANIFEST_PATH);
        const again = lstatSync(ZCODE_RUNTIME_MANIFEST_PATH) as unknown as StatLike;
        if (!sameIdentity(manifestStat, again))
            fail('runtime-changed');
        const canonicalAgain = parseZcodeRuntimeInventory(rawAgain);
        if (zcodeRuntimeManifestDigest(canonicalAgain) !== digest)
            fail('runtime-changed');
        const rootAgain = dirSnapshots.get('');
        if (rootAgain === undefined || !sameIdentity(statGuard(ZCODE_RUNTIME_ROOT), rootAgain))
            fail('runtime-changed');
        for (const [rel, snapshot] of dirSnapshots)
            if (!sameIdentity(statGuard(absOf(rel)), snapshot))
                fail('runtime-changed');
        for (const [rel, snapshot] of fileSnapshots)
            if (!sameIdentity(statGuard(absOf(rel)), snapshot))
                fail('runtime-changed');
        const nodeStat = statGuard(join(ZCODE_RUNTIME_ROOT, canonical.entries.node));
        if (!nodeStat.isFile() || (nodeStat.mode & 0o100) === 0 || (nodeStat.mode & 0o6000) !== 0)
            fail('runtime-changed');
    }
    catch (error) {
        if (error instanceof ZcodeRuntimeInventoryError)
            throw error;
        fail('protected-read');
    }
    const receipt = deepFreeze({
        kind: 'protected-runtime-inventory-verified' as const,
        root: ZCODE_RUNTIME_ROOT,
        manifestDigest: digest,
        fileCount: canonical.files.length,
        totalBytes,
        entries: Object.freeze({
            node: join(ZCODE_RUNTIME_ROOT, canonical.entries.node),
            loader: join(ZCODE_RUNTIME_ROOT, canonical.entries.loader),
            bootstrap: join(ZCODE_RUNTIME_ROOT, canonical.entries.bootstrap),
            cli: join(ZCODE_RUNTIME_ROOT, canonical.entries.cli),
            builtin: join(ZCODE_RUNTIME_ROOT, canonical.entries.builtin),
        }),
    });
    verifiedReceipts.add(receipt);
    return receipt;
}
