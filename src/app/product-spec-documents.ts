import { LocalProductSpecRequestSchema, type LocalProductSpecRequest } from '../core/product-spec.js';
import { ArtifactDigestError, computeLocalArtifactDigest } from '../core/artifact-digest.js';

/**
 * 本地交付制品的完整性前置检查（W5 返修：与摘要计算共用同一套递归验证）。
 *
 * 直接子项检查会漏掉嵌套 .md——摘要计算是递归的，这里必须以同一递归为准，
 * 嵌套唯一票据也应可提交；符号链接/缺失/空目录同样在提交点失败关闭。
 */
export async function assertProductSpecDocuments(
  workspaceDir: string,
  request: LocalProductSpecRequest,
): Promise<void> {
  LocalProductSpecRequestSchema.parse(request);
  try {
    await computeLocalArtifactDigest(workspaceDir, request);
  } catch (error) {
    if (!(error instanceof ArtifactDigestError)) throw error;
    const item = error.code.startsWith('spec') || error.message.includes('Spec')
      ? `Spec: ${request.specPath}`
      : `Tickets: ${request.ticketsPath}`;
    throw new Error([
      '产品方案尚未完整写入工作区，不能展示。',
      `- ${item}（${error.message}）`,
    ].join('\n'));
  }
}
