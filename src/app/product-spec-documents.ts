import { readdir, stat, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { LocalProductSpecRequestSchema, type LocalProductSpecRequest } from '../core/product-spec.js';

export async function assertProductSpecDocuments(
  workspaceDir: string,
  request: LocalProductSpecRequest,
): Promise<void> {
  LocalProductSpecRequestSchema.parse(request);
  const missing: string[] = [];
  const root = await realpath(workspaceDir);
  const containedPath = async (path: string): Promise<string> => {
    const actual = await realpath(resolve(root, path));
    const rel = relative(root, actual);
    if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) {
      throw new Error('产物通过符号链接越出了工作区');
    }
    return actual;
  };

  try {
    const info = await stat(await containedPath(request.specPath));
    if (!info.isFile()) missing.push(`Spec: ${request.specPath}`);
  } catch {
    missing.push(`Spec: ${request.specPath}`);
  }

  try {
    const ticketsDir = await containedPath(request.ticketsPath);
    const info = await stat(ticketsDir);
    const entries = info.isDirectory()
      ? await readdir(ticketsDir, { withFileTypes: true })
      : [];
    const hasTicket = entries.some(
      (entry) => entry.isFile() && entry.name.endsWith('.md'),
    );
    if (!info.isDirectory() || !hasTicket) {
      missing.push(`Tickets: ${request.ticketsPath}`);
    }
  } catch {
    missing.push(`Tickets: ${request.ticketsPath}`);
  }

  if (missing.length) {
    throw new Error([
      '产品方案尚未完整写入工作区，不能展示。',
      ...missing.map((item) => `- ${item}`),
    ].join('\n'));
  }
}
