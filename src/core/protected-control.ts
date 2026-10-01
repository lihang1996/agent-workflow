/** Formal host configuration cannot be redirected by an env var or task payload. */
import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
export const CONTROL_ROOT = process.platform === 'darwin' ? '/private/var/lib/agent-os/control' : '/var/lib/agent-os/control';
/** Root ownership of every ancestor closes task-writable replacement/import paths. */
export function assertProtectedPath(file: string, executable = false): void {
    if (!isAbsolute(file) || !existsSync(file))
        throw new Error('Protected host configuration missing');
    for (let p = dirname(file);; p = dirname(p)) {
        const s = lstatSync(p);
        if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o022))
            throw new Error('Unprotected host config ancestor');
        if (p === dirname(p))
            break;
    }
    if (realpathSync(file) !== file)
        throw new Error('Host config symlink rejected');
    const before = lstatSync(file);
    if ((!before.isFile() && !before.isDirectory()) || before.uid !== 0 || (before.mode & 0o022)
        || (!before.isDirectory() && !executable && (before.mode & 0o137)))
        throw new Error('Unprotected host config file');
}
export function assertProtectedPayloadTree(root: string, entry: string): void {
    assertProtectedPath(root);
    const rel = relative(root, entry);
    if (!rel || rel.startsWith('..') || isAbsolute(rel))
        throw new Error('Worker entry outside protected deployment tree');
    const visit = (path: string) => {
        assertProtectedPath(path, true);
        if (lstatSync(path).isDirectory())
            for (const name of readdirSync(path))
                visit(join(path, name));
    };
    visit(root);
}
export function readProtectedJson(file: string): unknown {
    assertProtectedPath(file);
    const before = lstatSync(file);
    if (!before.isFile() || before.size > 4194304)
        throw new Error('Invalid host config file');
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const s = fstatSync(fd), raw = readFileSync(fd, 'utf8'), after = fstatSync(fd), named = lstatSync(file);
        if (s.dev !== before.dev || s.ino !== before.ino || s.ctimeMs !== after.ctimeMs || s.size !== after.size || named.ino !== s.ino || named.dev !== s.dev)
            throw new Error('Host config changed during read');
        return JSON.parse(raw);
    }
    finally {
        closeSync(fd);
    }
}
