import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { CONTROL_ROOT } from '../src/core/protected-control.js';
import {
    ZCODE_RUNTIME_ROOT,
    ZCODE_RUNTIME_MANIFEST_PATH,
    ZCODE_RUNTIME_INVENTORY_LIMITS,
    ZcodeRuntimeInventoryError,
    parseZcodeRuntimeInventory,
    verifyZcodeRuntimeInventorySnapshot,
    zcodeRuntimeManifestDigest,
    loadProtectedZcodeRuntimeInventory,
    isProtectedZcodeRuntimeInventory,
} from '../src/core/zcode-runtime-inventory.js';

/**
 * A04/B3a：受保护 zcode runtime 文件 inventory 的纯 fixture 测试 + 真实
 * loader 的 fs 行为模拟测试。不触及真实 CONTROL_ROOT、不 sudo；loader 测试
 * 通过默认导入 fs + syncBuiltinESMExports 在测试进程内替换/恢复 fs 方法，
 * 具名导入随之更新。树是纯内存显式 fixture，uid 0 只是 mock 值，不生成
 * 实际安装证明。
 */

const hashOf = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex');

const baseManifest = () => ({
    schema: 'zcode-runtime-inventory/1',
    revision: 'r1.2_3',
    entries: {
        node: 'bin/node',
        loader: 'lib/loader.js',
        bootstrap: 'lib/bootstrap.js',
        cli: 'bin/cli',
        builtin: 'builtin/index.js',
    },
    directories: ['lib', 'bin', 'builtin'],
    files: [
        { path: 'builtin/index.js', sha256: hashOf('builtin'), bytes: 7 },
        { path: 'lib/bootstrap.js', sha256: hashOf('bootstrap'), bytes: 9 },
        { path: 'bin/node', sha256: hashOf('node'), bytes: 4 },
        { path: 'lib/loader.js', sha256: hashOf('loader'), bytes: 6 },
        { path: 'bin/cli', sha256: hashOf('cli'), bytes: 3 },
    ],
});

const CONTENTS: Record<string, string> = {
    'builtin/index.js': 'builtin',
    'lib/bootstrap.js': 'bootstrap',
    'bin/node': 'node',
    'lib/loader.js': 'loader',
    'bin/cli': 'cli',
};

const snapshotOf = (manifest: ReturnType<typeof parseZcodeRuntimeInventory>) => ({
    directories: manifest.directories.map((path) => ({ path, uid: 0, mode: 0o755 })),
    files: manifest.files.map((file) => ({
        path: file.path,
        uid: 0,
        mode: file.path === manifest.entries.node ? 0o755 : 0o644,
        nlink: 1,
        bytes: file.bytes,
        sha256: file.sha256,
    })),
});

function expectCode(code: string, run: () => unknown): void {
    let caught: unknown;
    try {
        run();
    }
    catch (error) {
        caught = error;
    }
    assert.ok(caught instanceof ZcodeRuntimeInventoryError, `expected ZcodeRuntimeInventoryError for ${code}`);
    assert.equal((caught as ZcodeRuntimeInventoryError).code, code);
    const message = (caught as Error).message;
    assert.ok(!message.includes('fake-secret'), 'error message must not leak input paths');
    assert.ok(!message.includes('/'), 'error message must not leak absolute paths');
    assert.ok(!message.includes('bin/node'), 'error message must not leak entry paths');
}

test('fixed production paths derive from CONTROL_ROOT only', () => {
    assert.equal(ZCODE_RUNTIME_ROOT, CONTROL_ROOT + '/zcode/runtime');
    assert.equal(ZCODE_RUNTIME_MANIFEST_PATH, CONTROL_ROOT + '/zcode/runtime-manifest.json');
    assert.ok(ZCODE_RUNTIME_ROOT.startsWith('/'));
});

test('budget limits are frozen and exact', () => {
    assert.ok(Object.isFrozen(ZCODE_RUNTIME_INVENTORY_LIMITS));
    assert.deepEqual(ZCODE_RUNTIME_INVENTORY_LIMITS, {
        maxFiles: 20000,
        maxDirectories: 20000,
        maxDepth: 32,
        maxFileBytes: 268435456,
        maxTotalBytes: 1073741824,
        maxPathBytes: 1024,
        maxRevisionLength: 128,
    });
});

test('parse canonicalizes, sorts, deep-freezes and leaves the input untouched', () => {
    const input = baseManifest();
    const inputBefore = JSON.parse(JSON.stringify(input));
    const manifest = parseZcodeRuntimeInventory(input);
    assert.deepEqual(JSON.parse(JSON.stringify(input)), inputBefore, 'caller input must not be mutated');
    assert.ok(!Object.isFrozen(input), 'caller input must not be frozen');
    assert.deepEqual(manifest.files.map((file) => file.path), ['bin/cli', 'bin/node', 'builtin/index.js', 'lib/bootstrap.js', 'lib/loader.js']);
    assert.deepEqual(manifest.directories, ['bin', 'builtin', 'lib']);
    assert.ok(Object.isFrozen(manifest) && Object.isFrozen(manifest.files) && Object.isFrozen(manifest.files[0]));
    assert.ok(Object.isFrozen(manifest.directories) && Object.isFrozen(manifest.entries));
    assert.throws(() => { (manifest.files as unknown as { push(x: unknown): void }).push({}); }, TypeError);
    assert.equal(manifest.schema, 'zcode-runtime-inventory/1');
});

test('manifest digest is order-independent and sensitive to entries, revision and hashes', () => {
    const a = parseZcodeRuntimeInventory(baseManifest());
    const shuffled = baseManifest();
    shuffled.files = [...shuffled.files].reverse();
    shuffled.directories = [...shuffled.directories].reverse();
    assert.equal(zcodeRuntimeManifestDigest(parseZcodeRuntimeInventory(shuffled)), zcodeRuntimeManifestDigest(a));
    for (const mutate of [
        (m: ReturnType<typeof baseManifest>) => { m.revision = 'other-rev'; },
        (m: ReturnType<typeof baseManifest>) => { m.entries.cli = 'bin/node2'; },
        (m: ReturnType<typeof baseManifest>) => { m.files[0].sha256 = hashOf('tampered'); },
        (m: ReturnType<typeof baseManifest>) => { m.files[0].bytes += 1; },
        (m: ReturnType<typeof baseManifest>) => { m.files.pop(); },
    ]) {
        const mutated = baseManifest();
        mutate(mutated);
        if (mutated.files.length === 4)
            mutated.entries.builtin = 'lib/bootstrap.js';
        const digestB = (() => {
            try {
                return zcodeRuntimeManifestDigest(parseZcodeRuntimeInventory(mutated));
            }
            catch {
                return 'unparseable';
            }
        })();
        assert.notEqual(digestB, zcodeRuntimeManifestDigest(a));
    }
});

test('rejects unknown and missing manifest fields', () => {
    for (const mutate of [
        (m: ReturnType<typeof baseManifest>) => { Reflect.deleteProperty(m, 'schema'); },
        (m: ReturnType<typeof baseManifest>) => { Reflect.deleteProperty(m, 'revision'); },
        (m: ReturnType<typeof baseManifest>) => { Reflect.deleteProperty(m, 'entries'); },
        (m: ReturnType<typeof baseManifest>) => { Reflect.deleteProperty(m, 'directories'); },
        (m: ReturnType<typeof baseManifest>) => { Reflect.deleteProperty(m, 'files'); },
        (m: ReturnType<typeof baseManifest>) => { (m as Record<string, unknown>).extra = 1; },
        (m: ReturnType<typeof baseManifest>) => { Reflect.deleteProperty(m.entries, 'cli'); },
        (m: ReturnType<typeof baseManifest>) => { (m.entries as Record<string, unknown>).extra = 'bin/cli'; },
        (m: ReturnType<typeof baseManifest>) => { (m.files[0] as Record<string, unknown>).mode = 0o644; },
        (m: ReturnType<typeof baseManifest>) => { m.files = []; },
        (m: ReturnType<typeof baseManifest>) => { (m as { directories: unknown }).directories = 'bin'; },
        // 原型继承的必需字段不能替代自有键，替代/未知键一律拒绝。
        (m: ReturnType<typeof baseManifest>) => {
            const hijacked = Object.create(m.entries) as unknown as { cli: string; node: string };
            (m as { entries: unknown }).entries = hijacked;
        },
    ])
        expectCode('manifest-shape', () => {
            const mutated = baseManifest();
            mutate(mutated);
            parseZcodeRuntimeInventory(mutated);
        });
    expectCode('manifest-shape', () => parseZcodeRuntimeInventory('nope'));
    expectCode('manifest-shape', () => parseZcodeRuntimeInventory(null));
});

test('rejects invalid revisions', () => {
    for (const revision of ['a'.repeat(129), 'has space', '中文', 'rev/1'])
        expectCode('manifest-revision', () => {
            const mutated = baseManifest();
            mutated.revision = revision;
            parseZcodeRuntimeInventory(mutated);
        });
    for (const revision of ['', 42, null])
        expectCode('manifest-revision', () => {
            const mutated = baseManifest();
            (mutated as Record<string, unknown>).revision = revision;
            parseZcodeRuntimeInventory(mutated);
        });
    const long = 'a'.repeat(128);
    const mutated = baseManifest();
    mutated.revision = long;
    parseZcodeRuntimeInventory(mutated);
});

test('rejects traversal, empty segments, control characters and oversized paths', () => {
    for (const path of ['/abs/node', '../node', 'bin/../node', './node', 'bin//node', 'bin/', 'bin\\node', 'bin\nnode', 'bin\0node', '', 'a'.repeat(1025), 'ä'.repeat(600), Array(33).fill('a').join('/'), 42])
        expectCode('manifest-path', () => {
            const mutated = baseManifest();
            mutated.files[0].path = path as string;
            parseZcodeRuntimeInventory(mutated);
        });
    const depth32 = Array(31).fill('a').join('/') + '/f.js';
    const chainDirectories = Array.from({ length: 31 }, (_, i) => Array(i + 1).fill('a').join('/'));
    const deep = {
        schema: 'zcode-runtime-inventory/1',
        revision: 'r1',
        entries: { node: 'bin/node', loader: 'lib/loader.js', bootstrap: 'lib/bootstrap.js', cli: 'bin/cli', builtin: depth32 },
        directories: ['bin', 'lib', ...chainDirectories],
        files: [
            { path: 'bin/node', sha256: hashOf('node'), bytes: 4 },
            { path: 'bin/cli', sha256: hashOf('cli'), bytes: 3 },
            { path: 'lib/loader.js', sha256: hashOf('loader'), bytes: 6 },
            { path: 'lib/bootstrap.js', sha256: hashOf('bootstrap'), bytes: 9 },
            { path: depth32, sha256: hashOf('x'), bytes: 1 },
        ],
    };
    parseZcodeRuntimeInventory(deep);
});

test('rejects invalid digests and byte counts', () => {
    for (const sha256 of [hashOf('x').toUpperCase(), 'abc', '', hashOf('x') + '0'])
        expectCode('manifest-hash', () => {
            const mutated = baseManifest();
            mutated.files[0].sha256 = sha256;
            parseZcodeRuntimeInventory(mutated);
        });
    for (const sha256 of [42, null])
        expectCode('manifest-hash', () => {
            const mutated = baseManifest();
            (mutated.files[0] as Record<string, unknown>).sha256 = sha256;
            parseZcodeRuntimeInventory(mutated);
        });
    for (const bytes of [NaN, Infinity, -Infinity, -1, 1.5, '4', null])
        expectCode('manifest-bytes', () => {
            const mutated = baseManifest();
            (mutated.files[0] as Record<string, unknown>).bytes = bytes;
            parseZcodeRuntimeInventory(mutated);
        });
    expectCode('manifest-budget', () => {
        const mutated = baseManifest();
        mutated.files[0].bytes = ZCODE_RUNTIME_INVENTORY_LIMITS.maxFileBytes + 1;
        parseZcodeRuntimeInventory(mutated);
    });
    expectCode('manifest-budget', () => {
        const mutated = baseManifest();
        mutated.files = Array.from({ length: ZCODE_RUNTIME_INVENTORY_LIMITS.maxFiles + 1 }, (_, i) => ({ path: `bin/f${i}`, sha256: hashOf('x'), bytes: 1 }));
        mutated.entries = { node: 'bin/f0', loader: 'bin/f1', bootstrap: 'bin/f2', cli: 'bin/f3', builtin: 'bin/f4' };
        parseZcodeRuntimeInventory(mutated);
    });
    expectCode('manifest-budget', () => {
        const mutated = baseManifest();
        mutated.files = [
            { path: 'bin/a', sha256: hashOf('a'), bytes: 536870912 },
            { path: 'bin/b', sha256: hashOf('b'), bytes: 536870913 },
            { path: 'bin/c', sha256: hashOf('c'), bytes: 0 },
            { path: 'bin/d', sha256: hashOf('d'), bytes: 0 },
            { path: 'bin/e', sha256: hashOf('e'), bytes: 0 },
        ];
        mutated.entries = { node: 'bin/a', loader: 'bin/b', bootstrap: 'bin/c', cli: 'bin/d', builtin: 'bin/e' };
        parseZcodeRuntimeInventory(mutated);
    });
    // 总量正好等于上限：允许。
    const exact = baseManifest();
    exact.files = [
        { path: 'bin/a', sha256: hashOf('a'), bytes: 214748365 },
        { path: 'bin/b', sha256: hashOf('b'), bytes: 214748365 },
        { path: 'bin/c', sha256: hashOf('c'), bytes: 214748365 },
        { path: 'bin/d', sha256: hashOf('d'), bytes: 214748365 },
        { path: 'bin/e', sha256: hashOf('e'), bytes: 214748364 },
    ];
    exact.entries = { node: 'bin/a', loader: 'bin/b', bootstrap: 'bin/c', cli: 'bin/d', builtin: 'bin/e' };
    parseZcodeRuntimeInventory(exact);
});

test('rejects duplicate files, duplicate directories and file/directory conflicts', () => {
    expectCode('manifest-budget', () => {
        const mutated = baseManifest();
        mutated.files[1] = { ...mutated.files[0] };
        parseZcodeRuntimeInventory(mutated);
    });
    expectCode('manifest-directories', () => {
        const mutated = baseManifest();
        mutated.directories.push('bin');
        parseZcodeRuntimeInventory(mutated);
    });
    expectCode('manifest-directories', () => {
        const mutated = baseManifest();
        mutated.directories.push('bin/node');
        parseZcodeRuntimeInventory(mutated);
    });
});

test('rejects incomplete directory parent chains', () => {
    expectCode('manifest-directories', () => {
        const mutated = baseManifest();
        mutated.files.push({ path: 'nested/deep/tool.js', sha256: hashOf('t'), bytes: 4 });
        parseZcodeRuntimeInventory(mutated);
    });
    expectCode('manifest-directories', () => {
        const mutated = baseManifest();
        mutated.directories = ['bin', 'builtin', 'nested/deep'];
        parseZcodeRuntimeInventory(mutated);
    });
    expectCode('manifest-directories', () => {
        const mutated = baseManifest();
        mutated.files.push({ path: 'lib/x.js', sha256: hashOf('x'), bytes: 1 });
        mutated.files.push({ path: 'lib/x.js/y.js', sha256: hashOf('y'), bytes: 1 });
        mutated.directories.push('lib/x.js');
        parseZcodeRuntimeInventory(mutated);
    });
    // 根下文件直接父目录为空：无需目录记录。
    const rootLevel = baseManifest();
    rootLevel.files.push({ path: 'rootfile.js', sha256: hashOf('r'), bytes: 1 });
    parseZcodeRuntimeInventory(rootLevel);
});

test('rejects missing or conflicting entry mappings', () => {
    expectCode('manifest-entries', () => {
        const mutated = baseManifest();
        mutated.entries.cli = 'bin/missing';
        parseZcodeRuntimeInventory(mutated);
    });
    expectCode('manifest-entries', () => {
        const mutated = baseManifest();
        mutated.entries.cli = mutated.entries.node;
        parseZcodeRuntimeInventory(mutated);
    });
});

test('snapshot fixture matches and returns a frozen non-production receipt', () => {
    const manifest = parseZcodeRuntimeInventory(baseManifest());
    const receipt = verifyZcodeRuntimeInventorySnapshot(manifest, snapshotOf(manifest));
    assert.equal(receipt.kind, 'inventory-snapshot-matched');
    assert.equal(receipt.manifestDigest, zcodeRuntimeManifestDigest(manifest));
    assert.equal(receipt.fileCount, 5);
    assert.equal(receipt.totalBytes, 29);
    assert.ok(Object.isFrozen(receipt));
    assert.ok(!isProtectedZcodeRuntimeInventory(receipt), 'fixture verification must never mint a production receipt');
    // 乱序 snapshot 仍然匹配（manifest canonical 化后精确比较）。
    const shuffled = snapshotOf(manifest);
    shuffled.files = [...shuffled.files].reverse();
    shuffled.directories = [...shuffled.directories].reverse();
    assert.equal(verifyZcodeRuntimeInventorySnapshot(manifest, shuffled).manifestDigest, receipt.manifestDigest);
});

test('snapshot rejects ownership, mode, nlink and node-execute violations', () => {
    const manifest = parseZcodeRuntimeInventory(baseManifest());
    const variant = (mutate: (snapshot: ReturnType<typeof snapshotOf>) => void) => {
        const snapshot = snapshotOf(manifest);
        mutate(snapshot);
        return snapshot;
    };
    expectCode('snapshot-ownership', () => verifyZcodeRuntimeInventorySnapshot(manifest, variant((s) => { s.files[0].uid = 1000; })));
    expectCode('snapshot-ownership', () => verifyZcodeRuntimeInventorySnapshot(manifest, variant((s) => { s.directories[0].uid = 12; })));
    expectCode('snapshot-mode', () => verifyZcodeRuntimeInventorySnapshot(manifest, variant((s) => { s.directories[0].mode = 0o770; })));
    expectCode('snapshot-mode', () => verifyZcodeRuntimeInventorySnapshot(manifest, variant((s) => { s.files[0].mode = 0o646; })));
    expectCode('snapshot-mode', () => verifyZcodeRuntimeInventorySnapshot(manifest, variant((s) => { s.files[1].mode = 0o644; })));
    // setuid / setgid fixture 文件必须拒绝。
    expectCode('snapshot-mode', () => verifyZcodeRuntimeInventorySnapshot(manifest, variant((s) => { s.files[0].mode = 0o4644; })));
    expectCode('snapshot-mode', () => verifyZcodeRuntimeInventorySnapshot(manifest, variant((s) => { s.files[0].mode = 0o2644; })));
    expectCode('snapshot-nlink', () => verifyZcodeRuntimeInventorySnapshot(manifest, variant((s) => { s.files[0].nlink = 2; })));
    expectCode('snapshot-shape', () => verifyZcodeRuntimeInventorySnapshot(manifest, variant((s) => { (s.files[0] as Record<string, unknown>).mode = 0o200000; })));
    expectCode('snapshot-shape', () => verifyZcodeRuntimeInventorySnapshot(manifest, variant((s) => { s.files[0].bytes = NaN; })));
    expectCode('snapshot-shape', () => verifyZcodeRuntimeInventorySnapshot(manifest, variant((s) => { (s.files[0] as Record<string, unknown>).extra = 1; })));
    expectCode('snapshot-shape', () => verifyZcodeRuntimeInventorySnapshot(manifest, null));
});

test('snapshot rejects added, missing, size- and hash-mismatched entries', () => {
    const manifest = parseZcodeRuntimeInventory(baseManifest());
    const variant = (mutate: (snapshot: ReturnType<typeof snapshotOf>) => void) => () => {
        const snapshot = snapshotOf(manifest);
        mutate(snapshot);
        verifyZcodeRuntimeInventorySnapshot(manifest, snapshot);
    };
    expectCode('snapshot-missing', variant((s) => { s.files.pop(); }));
    expectCode('snapshot-missing', variant((s) => { s.directories.pop(); }));
    expectCode('snapshot-extra', variant((s) => { s.files.push({ path: 'bin/extra', uid: 0, mode: 0o644, nlink: 1, bytes: 1, sha256: hashOf('e') }); }));
    expectCode('snapshot-extra', variant((s) => { s.directories.push({ path: 'extra.d', uid: 0, mode: 0o755 }); }));
    expectCode('snapshot-size', variant((s) => { s.files[0].bytes += 1; }));
    expectCode('snapshot-hash', variant((s) => { s.files[0].sha256 = hashOf('other'); }));
});

test('copies and parse outputs can never impersonate a production receipt', () => {
    const manifest = parseZcodeRuntimeInventory(baseManifest());
    const receipt = verifyZcodeRuntimeInventorySnapshot(manifest, snapshotOf(manifest));
    for (const impostor of [manifest, receipt, { ...receipt }, JSON.parse(JSON.stringify(receipt)), null])
        assert.ok(!isProtectedZcodeRuntimeInventory(impostor));
});

test('error class derives a fixed message from the code only', () => {
    const error = new ZcodeRuntimeInventoryError('protected-read');
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'ZcodeRuntimeInventoryError');
    assert.equal(error.code, 'protected-read');
    assert.equal(error.message, 'protected zcode runtime read failed');
    // 构造器不接受任意 message：类型上只有 code 参数，所有实例消息来自固定映射。
    for (const code of ['manifest-shape', 'runtime-changed', 'snapshot-extra'] as const)
        assert.equal(new ZcodeRuntimeInventoryError(code).message.length > 0, true);
    expectCode('manifest-path', () => parseZcodeRuntimeInventory({ ...baseManifest(), entries: { ...baseManifest().entries, node: 'fake-secret/../node' } }));
});

test('production loader is a fixed-path zero-argument verifier or fails closed', () => {
    assert.equal(loadProtectedZcodeRuntimeInventory.length, 0);
    // 固定拒绝或固定成功：不允许 skip，也不假设真实根不存在。
    try {
        const receipt = loadProtectedZcodeRuntimeInventory();
        assert.ok(isProtectedZcodeRuntimeInventory(receipt), 'real loader success must be a registered receipt');
        assert.equal(receipt.kind, 'protected-runtime-inventory-verified');
        assert.equal(receipt.root, ZCODE_RUNTIME_ROOT);
        assert.ok(/^[0-9a-f]{64}$/.test(receipt.manifestDigest));
        assert.ok(!isProtectedZcodeRuntimeInventory({ ...receipt }));
    }
    catch (error) {
        assert.ok(error instanceof ZcodeRuntimeInventoryError, `loader must fail with a fixed error, got: ${String(error)}`);
        assert.ok(['protected-read', 'runtime-changed', 'manifest-shape', 'manifest-path', 'manifest-revision', 'manifest-hash', 'manifest-bytes', 'manifest-budget', 'manifest-directories', 'manifest-entries'].includes(error.code));
        if (!fs.existsSync(ZCODE_RUNTIME_ROOT))
            assert.equal(error.code, 'protected-read', 'missing real root must be a fixed protected-read rejection');
    }
});

/* ------------------------------------------------------------------------- */
/* 真实 loader 的 fs 行为模拟：内存 fixture + syncBuiltinESMExports。         */
/* ------------------------------------------------------------------------- */

type FakeKind = 'file' | 'dir' | 'symlink' | 'fifo';

interface FakeStatFields {
    dev: number; ino: number; uid: number; gid: number;
    mode: number; nlink: number; mtimeMs: number; ctimeMs: number;
}

interface FakeEntry {
    kind: FakeKind;
    data: Buffer;
    names: string[];
    stat: FakeStatFields;
}

/** 纯内存文件系统：覆盖 loader 与 protected-control 用到的全部同步 fs 面。 */
class FakeTree {
    readonly entries = new Map<string, FakeEntry>();
    readonly openFiles = new Map<number, { path: string; pos: number }>();
    /** 每个 fd / Dir 句柄的成功进入 closeSync 的尝试次数（含抛错的那次）。 */
    readonly closeCounts = new Map<number, number>();
    readonly dirCloseCounts = new Map<number, number>();
    readonly openDirs = new Set<number>();
    /** 对已释放句柄的重复 close：真实代码绝不允许出现。 */
    doubleCloseAttempts = 0;
    private fdSeq = 100;
    private dirSeq = 500;
    private inoSeq = 1;
    private opendirCounts = new Map<string, number>();
    readFails = false;
    closeFails = false;
    /** 定点 close 失败：只让指定 runtime 文件/目录的 close 抛错。 */
    readonly closeFailFiles = new Set<string>();
    readonly closeFailDirs = new Set<string>();
    onOpen: ((path: string) => void) | null = null;
    onCloseFd: ((path: string) => void) | null = null;
    onSecondOpendir: ((path: string) => void) | null = null;

    constructor() {
        this.addEntry('/', 'dir', 0o755);
    }

    private addEntry(path: string, kind: FakeKind, mode: number, data = Buffer.alloc(0)): FakeEntry {
        const entry: FakeEntry = {
            kind, data, names: [],
            stat: { dev: 1, ino: ++this.inoSeq, uid: 0, gid: 0, mode, nlink: 1, mtimeMs: 1e12, ctimeMs: 1e12 },
        };
        this.entries.set(path, entry);
        if (path !== '/') {
            const parent = this.entries.get(path.slice(0, path.lastIndexOf('/')) || '/');
            parent?.names.push(path.slice(path.lastIndexOf('/') + 1));
            if (parent) parent.stat.nlink += 1;
        }
        return entry;
    }

    mkdirp(path: string, mode = 0o755): void {
        const segments = path.split('/').filter(Boolean);
        let current = '';
        for (const segment of segments) {
            current += '/' + segment;
            if (!this.entries.has(current))
                this.addEntry(current, 'dir', mode);
        }
    }

    addFile(path: string, content: string, mode = 0o644): FakeEntry {
        const entry = this.addEntry(path, 'file', mode, Buffer.from(content, 'utf8'));
        return entry;
    }

    /** 覆盖已存在的路径（保持父目录 names 不变），用于把普通文件换成 symlink/fifo。 */
    addSpecial(path: string, kind: FakeKind): void {
        if (this.entries.has(path)) {
            this.entries.set(path, {
                kind, data: Buffer.alloc(0), names: [],
                stat: { dev: 1, ino: ++this.inoSeq, uid: 0, gid: 0, mode: kind === 'symlink' ? 0o777 : 0o644, nlink: 1, mtimeMs: 1e12, ctimeMs: 1e12 },
            });
            return;
        }
        this.addEntry(path, kind, kind === 'symlink' ? 0o777 : 0o644);
    }

    /** 内容（可同长度替换）与时间戳漂移。 */
    drift(path: string, sameLengthContent?: string): void {
        const entry = this.entries.get(path);
        assert.ok(entry !== undefined, `fixture drift target missing: ${path}`);
        if (sameLengthContent !== undefined)
            entry.data = Buffer.from(sameLengthContent, 'utf8');
        entry.stat.mtimeMs += 5000;
        entry.stat.ctimeMs += 5000;
    }

    /** 同名目录替换：新 inode。 */
    replaceIdentity(path: string): void {
        const entry = this.entries.get(path);
        assert.ok(entry !== undefined);
        entry.stat.ino = ++this.inoSeq;
        entry.stat.ctimeMs += 5000;
    }

    chmod(path: string, mode: number): void {
        const entry = this.entries.get(path);
        assert.ok(entry !== undefined);
        entry.stat.mode = mode;
        entry.stat.ctimeMs += 5000;
    }

    setNlink(path: string, nlink: number): void {
        const entry = this.entries.get(path);
        assert.ok(entry !== undefined);
        entry.stat.nlink = nlink;
    }

    private view(entry: FakeEntry) {
        return {
            dev: entry.stat.dev, ino: entry.stat.ino, uid: entry.stat.uid, gid: entry.stat.gid,
            mode: entry.stat.mode, nlink: entry.stat.nlink,
            size: entry.kind === 'file' ? entry.data.length : entry.kind === 'dir' ? 96 : entry.kind === 'symlink' ? 1 : 0,
            mtimeMs: entry.stat.mtimeMs, ctimeMs: entry.stat.ctimeMs,
            isDirectory: () => entry.kind === 'dir',
            isFile: () => entry.kind === 'file',
            isSymbolicLink: () => entry.kind === 'symlink',
        };
    }

    private notFound(path: string): never {
        throw Object.assign(new Error(`ENOENT: no such file or directory, openfake-secret '${path}'`), { code: 'ENOENT' });
    }

    lstat(path: string): ReturnType<FakeTree['view']> {
        const entry = this.entries.get(path);
        if (entry === undefined)
            this.notFound(path);
        return this.view(entry);
    }

    existsSync(path: string): boolean {
        return this.entries.has(path);
    }

    realpathSync(path: string): string {
        const entry = this.entries.get(path);
        if (entry === undefined || entry.kind === 'symlink')
            throw Object.assign(new Error(`REALPATH fake-secret ${path}`), { code: 'ENOENT' });
        return path;
    }

    openSync(path: string): number {
        const entry = this.entries.get(path);
        if (entry === undefined)
            this.notFound(path);
        if (entry.kind === 'symlink')
            throw Object.assign(new Error('ELOOP fake-secret'), { code: 'ELOOP' });
        if (entry.kind !== 'file')
            throw Object.assign(new Error('EISDIR fake-secret'), { code: 'EISDIR' });
        const fd = ++this.fdSeq;
        this.openFiles.set(fd, { path, pos: 0 });
        this.onOpen?.(path);
        return fd;
    }

    private requireFd(fd: number): { path: string; pos: number } {
        const record = this.openFiles.get(fd);
        if (record === undefined)
            throw Object.assign(new Error('EBADF fake-secret'), { code: 'EBADF' });
        return record;
    }

    fstatSync(fd: number): ReturnType<FakeTree['view']> {
        return this.view(this.entries.get(this.requireFd(fd).path)!);
    }

    readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number | null): number {
        const record = this.requireFd(fd);
        const entry = this.entries.get(record.path)!;
        if (this.readFails)
            throw Object.assign(new Error('EIO: read error fake-secret'), { code: 'EIO' });
        const pos = position ?? record.pos;
        const available = Math.max(0, entry.data.length - pos);
        const count = Math.min(length, available);
        entry.data.copy(buffer, offset, pos, pos + count);
        if (position === null)
            record.pos = pos + count;
        return count;
    }

    readFileSync(fd: number): string {
        const record = this.requireFd(fd);
        return this.entries.get(record.path)!.data.toString('utf8');
    }

    closeSync(fd: number): void {
        const record = this.openFiles.get(fd);
        if (record === undefined) {
            this.doubleCloseAttempts++;
            throw Object.assign(new Error('EBADF fake-secret'), { code: 'EBADF' });
        }
        // POSIX 语义：close 抛错时 fd 可能已释放——先摘除再抛错，
        // 绝不在 fixture 中默默容忍二次 close。
        this.openFiles.delete(fd);
        this.closeCounts.set(fd, (this.closeCounts.get(fd) ?? 0) + 1);
        if (this.closeFails || this.closeFailFiles.has(record.path))
            throw Object.assign(new Error('close EBADF fake-secret'), { code: 'EBADF' });
        this.onCloseFd?.(record.path);
    }

    opendirSync(path: string): { readSync(): { name: string } | null; closeSync(): void } {
        const entry = this.entries.get(path);
        if (entry === undefined)
            this.notFound(path);
        if (entry.kind !== 'dir')
            throw Object.assign(new Error('ENOTDIR fake-secret'), { code: 'ENOTDIR' });
        const count = (this.opendirCounts.get(path) ?? 0) + 1;
        this.opendirCounts.set(path, count);
        if (count === 2)
            this.onSecondOpendir?.(path);
        const dirId = ++this.dirSeq;
        this.openDirs.add(dirId);
        let index = 0;
        return {
            readSync: () => (index < entry.names.length ? { name: entry.names[index++] } : null),
            closeSync: () => {
                if (!this.openDirs.has(dirId)) {
                    this.doubleCloseAttempts++;
                    throw Object.assign(new Error('EBADF fake-secret'), { code: 'EBADF' });
                }
                this.openDirs.delete(dirId);
                this.dirCloseCounts.set(dirId, (this.dirCloseCounts.get(dirId) ?? 0) + 1);
                if (this.closeFails || this.closeFailDirs.has(path))
                    throw Object.assign(new Error('closedir EBADF fake-secret'), { code: 'EBADF' });
            },
        };
    }
}

interface FixtureOptions {
    skipDirs?: string[];
    nodeMode?: number;
}

function buildRuntimeTree(manifestText: string, options?: FixtureOptions): { tree: FakeTree; manifest: ReturnType<typeof baseManifest> & { directories: string[] } } {
    const manifest = JSON.parse(manifestText) as ReturnType<typeof baseManifest>;
    const tree = new FakeTree();
    tree.mkdirp(CONTROL_ROOT + '/zcode');
    tree.addFile(ZCODE_RUNTIME_MANIFEST_PATH, manifestText, 0o600);
    tree.mkdirp(ZCODE_RUNTIME_ROOT);
    for (const dir of manifest.directories)
        if (!options?.skipDirs?.includes(dir))
            tree.mkdirp(join(ZCODE_RUNTIME_ROOT, dir));
    for (const file of manifest.files)
        tree.addFile(
            join(ZCODE_RUNTIME_ROOT, file.path),
            CONTENTS[file.path] ?? '',
            file.path === manifest.entries.node ? (options?.nodeMode ?? 0o755) : 0o644,
        );
    return { tree, manifest };
}

/** 在测试进程内替换 fs 方法（含具名 ESM 绑定），结束后完全恢复并断言零遗留 fd。 */
function withFakedFs(tree: FakeTree, run: () => void): void {
    const target = fs as unknown as Record<string, unknown>;
    const saved: Record<string, unknown> = {
        existsSync: fs.existsSync, lstatSync: fs.lstatSync, realpathSync: fs.realpathSync,
        openSync: fs.openSync, fstatSync: fs.fstatSync, readSync: fs.readSync,
        readFileSync: fs.readFileSync, closeSync: fs.closeSync, opendirSync: fs.opendirSync,
    };
    target.existsSync = (path: unknown) => tree.existsSync(String(path));
    target.lstatSync = (path: unknown) => tree.lstat(String(path));
    target.realpathSync = (path: unknown) => tree.realpathSync(String(path));
    target.openSync = (path: unknown) => tree.openSync(String(path));
    target.fstatSync = (fd: unknown) => tree.fstatSync(Number(fd));
    target.readSync = (fd: unknown, buffer: unknown, offset: unknown, length: unknown, position: unknown) =>
        tree.readSync(Number(fd), buffer as Buffer, Number(offset), Number(length), position === null ? null : Number(position));
    target.readFileSync = (fd: unknown) => tree.readFileSync(Number(fd));
    target.closeSync = (fd: unknown) => tree.closeSync(Number(fd));
    target.opendirSync = (path: unknown) => tree.opendirSync(String(path));
    syncBuiltinESMExports();
    try {
        run();
    }
    finally {
        Object.assign(target, saved);
        syncBuiltinESMExports();
        // 零遗留句柄 + 每个句柄恰好一次 close 尝试（含抛错路径），绝不二次 close。
        assert.equal(tree.openFiles.size, 0, 'loader must not leak open file descriptors');
        assert.equal(tree.openDirs.size, 0, 'loader must not leak directory handles');
        assert.equal(tree.doubleCloseAttempts, 0, 'each fd/Dir handle must receive at most one close');
        for (const [fd, count] of tree.closeCounts)
            assert.equal(count, 1, `fd ${fd} must have exactly one close attempt`);
        for (const [dirId, count] of tree.dirCloseCounts)
            assert.equal(count, 1, `Dir handle ${dirId} must have exactly one close attempt`);
    }
}

test('loader verifies a faithful fixture and mints a private receipt', () => {
    const manifestText = JSON.stringify(baseManifest());
    const { tree } = buildRuntimeTree(manifestText);
    let receipt: ReturnType<typeof loadProtectedZcodeRuntimeInventory> | undefined;
    withFakedFs(tree, () => {
        receipt = loadProtectedZcodeRuntimeInventory();
    });
    assert.ok(receipt !== undefined);
    assert.ok(isProtectedZcodeRuntimeInventory(receipt));
    assert.equal(receipt.kind, 'protected-runtime-inventory-verified');
    assert.equal(receipt.root, ZCODE_RUNTIME_ROOT);
    assert.equal(receipt.manifestDigest, zcodeRuntimeManifestDigest(parseZcodeRuntimeInventory(JSON.parse(manifestText))));
    assert.equal(receipt.fileCount, 5);
    assert.equal(receipt.totalBytes, 29);
    assert.equal(receipt.entries.node, join(ZCODE_RUNTIME_ROOT, 'bin/node'));
    assert.equal(receipt.entries.cli, join(ZCODE_RUNTIME_ROOT, 'bin/cli'));
    // 复制/序列化的 receipt 不能冒充。
    assert.ok(!isProtectedZcodeRuntimeInventory({ ...receipt }));
    assert.ok(!isProtectedZcodeRuntimeInventory(JSON.parse(JSON.stringify(receipt))));
});

test('loader rejects a manifest-listed empty directory missing from the tree', () => {
    const manifest = baseManifest();
    manifest.directories.push('empty');
    const manifestText = JSON.stringify(manifest);
    const { tree } = buildRuntimeTree(manifestText, { skipDirs: ['empty'] });
    withFakedFs(tree, () => {
        expectCode('runtime-changed', () => loadProtectedZcodeRuntimeInventory());
    });
});

test('loader rejects a directory present in the tree but missing from the manifest', () => {
    const manifestText = JSON.stringify(baseManifest());
    const { tree } = buildRuntimeTree(manifestText);
    tree.mkdirp(join(ZCODE_RUNTIME_ROOT, 'extra'));
    withFakedFs(tree, () => {
        expectCode('runtime-changed', () => loadProtectedZcodeRuntimeInventory());
    });
});

test('loader rejects same-named directory replacement between scan and recheck', () => {
    const manifestText = JSON.stringify(baseManifest());
    const { tree } = buildRuntimeTree(manifestText);
    const libDir = join(ZCODE_RUNTIME_ROOT, 'lib');
    tree.onSecondOpendir = (path) => {
        if (path === libDir)
            tree.replaceIdentity(libDir);
    };
    withFakedFs(tree, () => {
        expectCode('runtime-changed', () => loadProtectedZcodeRuntimeInventory());
    });
});

test('loader rejects late file drift after hashing (same-length content plus ctime/mtime)', () => {
    const manifestText = JSON.stringify(baseManifest());
    const { tree } = buildRuntimeTree(manifestText);
    const nodeAbs = join(ZCODE_RUNTIME_ROOT, 'bin/node');
    // 在所有文件 hash 完成后、目录复查阶段（root 第二次列举）替换 node 内容并漂移时间戳。
    tree.onSecondOpendir = (path) => {
        if (path === ZCODE_RUNTIME_ROOT)
            tree.drift(nodeAbs, 'NODE');
    };
    withFakedFs(tree, () => {
        expectCode('runtime-changed', () => loadProtectedZcodeRuntimeInventory());
    });
});

test('loader rejects file metadata change between lstat and open (same inode)', () => {
    const manifestText = JSON.stringify(baseManifest());
    const { tree } = buildRuntimeTree(manifestText);
    const nodeAbs = join(ZCODE_RUNTIME_ROOT, 'bin/node');
    tree.onOpen = (path) => {
        if (path === nodeAbs)
            tree.drift(nodeAbs);
    };
    withFakedFs(tree, () => {
        expectCode('runtime-changed', () => loadProtectedZcodeRuntimeInventory());
    });
});

test('loader rejects setuid and setgid runtime files', () => {
    for (const nodeMode of [0o4755, 0o2755]) {
        const manifestText = JSON.stringify(baseManifest());
        const { tree } = buildRuntimeTree(manifestText, { nodeMode });
        withFakedFs(tree, () => {
            expectCode('protected-read', () => loadProtectedZcodeRuntimeInventory());
        });
    }
});

test('loader rejects symlinks, hardlinks and special files', () => {
    for (const mutate of [
        (tree: FakeTree) => tree.addSpecial(join(ZCODE_RUNTIME_ROOT, 'bin/cli'), 'symlink'),
        (tree: FakeTree) => tree.setNlink(join(ZCODE_RUNTIME_ROOT, 'bin/cli'), 2),
        (tree: FakeTree) => tree.addSpecial(join(ZCODE_RUNTIME_ROOT, 'lib/loader.js'), 'fifo'),
    ]) {
        const manifestText = JSON.stringify(baseManifest());
        const { tree } = buildRuntimeTree(manifestText);
        mutate(tree);
        withFakedFs(tree, () => {
            expectCode('protected-read', () => loadProtectedZcodeRuntimeInventory());
        });
    }
});

test('loader wraps read and close failures with fixed errors and no fd leaks', () => {
    const readFailsText = JSON.stringify(baseManifest());
    const readCase = buildRuntimeTree(readFailsText);
    readCase.tree.readFails = true;
    withFakedFs(readCase.tree, () => {
        expectCode('protected-read', () => loadProtectedZcodeRuntimeInventory());
    });
    const closeFailsText = JSON.stringify(baseManifest());
    const closeCase = buildRuntimeTree(closeFailsText);
    closeCase.tree.closeFails = true;
    withFakedFs(closeCase.tree, () => {
        expectCode('protected-read', () => loadProtectedZcodeRuntimeInventory());
    });
});

test('runtime file close failure alone fails closed with exactly one close attempt per fd', () => {
    const manifestText = JSON.stringify(baseManifest());
    const { tree } = buildRuntimeTree(manifestText);
    // 只让 runtime 文件的 close 抛错：manifest 读取的 close 保持正常，
    // 不能让其第一次 close 提前失败掩盖真正的 runtime 关闭路径。
    const nodeAbs = join(ZCODE_RUNTIME_ROOT, 'bin/node');
    tree.closeFailFiles.add(nodeAbs);
    withFakedFs(tree, () => {
        expectCode('protected-read', () => loadProtectedZcodeRuntimeInventory());
    });
    // close 在抛错前已释放 fd（POSIX 语义）：无二次 close、零遗留，
    // 前一个文件的 fd 也恰好关闭一次。
    assert.ok(tree.closeCounts.size >= 2, 'hashing must have reached the failing runtime file');
});

test('directory close failure alone fails closed with exactly one close attempt per Dir', () => {
    const manifestText = JSON.stringify(baseManifest());
    const { tree } = buildRuntimeTree(manifestText);
    // 只让单个 runtime 目录的 close 抛错（模拟已释放再抛错），
    // 其余目录与 manifest 的 close 均正常。
    tree.closeFailDirs.add(join(ZCODE_RUNTIME_ROOT, 'bin'));
    withFakedFs(tree, () => {
        expectCode('protected-read', () => loadProtectedZcodeRuntimeInventory());
    });
    assert.ok(tree.dirCloseCounts.size >= 2, 'scan must have closed prior directories before the failing one');
});

test('loader counts directories exactly: 20000 manifest dirs plus root is legal', () => {
    const manifest = baseManifest();
    const extra = 20000 - manifest.directories.length;
    for (let i = 0; i < extra; i++)
        manifest.directories.push(`d${i}`);
    assert.equal(manifest.directories.length, 20000);
    const manifestText = JSON.stringify(manifest);
    const { tree } = buildRuntimeTree(manifestText);
    let receipt: ReturnType<typeof loadProtectedZcodeRuntimeInventory> | undefined;
    withFakedFs(tree, () => {
        receipt = loadProtectedZcodeRuntimeInventory();
    });
    assert.ok(receipt !== undefined && isProtectedZcodeRuntimeInventory(receipt));
    // 超限一个目录：manifest 层面直接拒绝。
    const over = JSON.parse(manifestText) as ReturnType<typeof baseManifest>;
    over.directories.push('overflow');
    expectCode('manifest-budget', () => parseZcodeRuntimeInventory(over));
});
