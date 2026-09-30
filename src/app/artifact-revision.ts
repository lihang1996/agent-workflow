import {
  localArtifactInputOf,
  readArchitectureArtifactSnapshot,
  readLocalArtifactSnapshot,
} from '../core/artifact-digest.js';
import type {
  ContentSource,
  ProductSpecFlow,
  ProductSpecFlowStore,
} from '../core/product-spec.js';

/**
 * T-019：待确认制品经评论修订后的摘要重算。
 *
 * 契约：**只有完整回读成功后才能重算并持久化摘要**。回读失败（或飞书模式
 * 没有已核验的完整回读能力，U-3）时：
 * - 绝不更新 flow 摘要（旧摘要继续生效——若文件确实已改，G1 会在确认时
 *   因摘要不一致拒绝，失败关闭）；
 * - 绝不向评论者回复「修改完成」——回复必须显式说明本次修改未经服务端核验。
 *
 * 完整文档 reader 是注入式依赖：本地模式使用与摘要计算同一套受控读取；
 * 飞书模式的真实完整回读（block 树/资源/顺序）尚未实证（U-3 blocked），
 * 生产不注入 reader，因此生产路径上的评论修订恒为「未核验」。
 */
export type RevisionVerification =
  | { status: 'verified'; digest: string; contentSources: ContentSource[] }
  | { status: 'unverified'; reason: string };

/** 注入式完整文档 reader：返回重算摘要与来源清单；任何失败抛错。 */
export type FullArtifactReader = (options: {
  flow: Pick<ProductSpecFlow, 'request' | 'artifact_kind'>;
  workspaceDir: string;
}) => Promise<{ digest: string; contentSources: ContentSource[] }>;

/** 本地制品 reader：与提交/审批点同一套受控读取（产品与架构制品分别处理）。 */
export const localArtifactReader: FullArtifactReader = async ({ flow, workspaceDir }) => {
  const input = localArtifactInputOf(flow);
  const snapshot = input.kind === 'architecture'
    ? await readArchitectureArtifactSnapshot(workspaceDir, input.request)
    : await readLocalArtifactSnapshot(workspaceDir, input.request);
  return { digest: snapshot.digest.digest, contentSources: snapshot.digest.content_sources };
};

export async function applyArtifactRevision(options: {
  flow: ProductSpecFlow;
  store: Pick<ProductSpecFlowStore, 'get' | 'rebindDigest'>;
  workspaceDir: string | undefined;
  /** 未提供（生产飞书路径，U-3 blocked）⇒ 一律「未核验」，失败关闭。 */
  readFullDocument?: FullArtifactReader;
}): Promise<RevisionVerification> {
  const { flow, store, workspaceDir } = options;
  const current = store.get(flow.token);
  if (!current || current.status !== 'pending') {
    return { status: 'unverified', reason: '制品已不在待确认状态，摘要不更新' };
  }
  if (!options.readFullDocument) {
    return {
      status: 'unverified',
      reason: '飞书完整文档回读能力尚未核验（U-3），无法重算摘要',
    };
  }
  if (!workspaceDir) {
    return { status: 'unverified', reason: '找不到会话工作区，无法回读制品' };
  }
  try {
    const read = await options.readFullDocument({
      flow: { request: current.request, artifact_kind: current.artifact_kind },
      workspaceDir,
    });
    const rebound = store.rebindDigest(current.token, read.digest, read.contentSources);
    if (!rebound) {
      return { status: 'unverified', reason: '制品状态在回读后发生变化，摘要未更新' };
    }
    return { status: 'verified', digest: read.digest, contentSources: read.contentSources };
  } catch (error) {
    const detail = (error as Error).message;
    return { status: 'unverified', reason: `完整回读失败：${detail}` };
  }
}

/**
 * 评论修订的回复文案（61 号 P1 修正）：
 * - **verified**：完整回读成功，才转述 CLI 对改动的说明（或服务端完成文案）；
 * - **unverified**：**不复述 CLI 的任何自述**——它可能含「修改完成/已更新」
 *   类成功承诺，而服务端没有核验依据；回复由服务端生成中性文案，只陈述
 *   「处理已尝试」与「核验缺口」，并给出人工核对指引。
 */
export function commentRevisionReply(
  cliAnswer: string,
  verification: RevisionVerification,
): string {
  if (verification.status === 'verified') {
    return cliAnswer || '已按评论更新原文档，并完成完整性核验，请复查。';
  }
  return [
    '这条评论的修改已提交执行，但服务端未能完成制品完整性核验，不能确认文档已按评论改好。',
    `核验缺口：${verification.reason}`,
    '请直接打开文档核对评论对应的改动；如未生效或不符合预期，请让对应成员重新生成制品后再进入确认流程（核验通过前确认通道保持关闭）。',
  ].join('\n');
}
