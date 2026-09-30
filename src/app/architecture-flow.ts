import {
  assertArtifactStillMatchesApproval,
  readArchitectureArtifactSnapshot,
} from '../core/artifact-digest.js';
import { assertArtifactRequestWithinScratch } from '../core/isolation.js';
import {
  KnowledgeCitationParseError,
  extractKnowledgeCitations,
  type KnowledgePrefetchLedger,
} from '../core/kb-prefetch.js';
import { resolveHandoffUpstream } from '../core/architecture-handoff.js';
import type { ArchitectureHandoffStore } from '../core/architecture-handoff.js';
import {
  productDocumentToken,
  type ArchitectureRequest,
  type ArchitectureUpstream,
  type ContentSource,
  type KnowledgeRef,
  type ProductSpecFlow,
  type ProductSpecFlowStore,
} from '../core/product-spec.js';
import type { CollaborationOrigin } from '../core/collaboration.js';

/**
 * 服务端架构制品创建（T-020）。与产品制品的 createBoundProductSpecFlow 共用
 * 摘要纪律（本地模式一次受控读取同时完成校验/摘要/正文；任何失败即失败关闭，
 * 不生成确认卡），但上游绑定只来自服务端架构交接（ArchitectureHandoff）：
 *
 * - 交接码必须是服务端签发、open、owner 与本次任务一致（零个候选失败关闭）；
 * - 上游 PRD 必须唯一、已批准、摘要与交接锚定一致，且**当前文件仍与批准摘要
 *   一致**（上游已漂移 ⇒ 拒绝创建，先重新走 PRD 确认）；
 * - CLI 自报的 artifact kind / 上游 token / 正文 URL 一概不是输入：工具 schema
 *   里根本没有这些字段；
 * - 架构 flow 继承该 PRD 的多系统知识引用清单与知识状态（G1 沿用同一套门禁）。
 *
 * 飞书交付模式：记录 lark content_source、digest=null（U-3 未核验，G1 拒绝确认）。
 */
export async function createBoundArchitectureFlow(options: {
  flows: ProductSpecFlowStore;
  handoffs: ArchitectureHandoffStore;
  workspaceDir: string;
  /**
   * T-022/W6b（119 号 P1-4）：本地交付**必填**——任务 scratch 相对根；缺失即
   * 失败关闭（生产调用方经 requireScratchRootForSubmission 获取）。
   */
  scratchRoot?: string;
  /** 上游 PRD 会话工作区解析（缺失 ⇒ 无法做上游漂移检查，失败关闭）。 */
  resolvePrdWorkspaceDir: (upstream: { prdSessionId: string }) => string | undefined;
  identity: {
    taskId: string;
    botId: string;
    sessionId: string;
    sessionVersion?: number;
    ownerOpenId: string;
    ownerUnionId?: string;
    ownerBotId?: string;
    collaboration?: CollaborationOrigin;
  };
  request: ArchitectureRequest;
  handoffToken: string;
}): Promise<ProductSpecFlow> {
  const { flows, handoffs, workspaceDir, identity, request } = options;
  if (request.deliveryMode === 'local') {
    if (!options.scratchRoot) {
      throw new Error('本地架构制品提交失败关闭：缺少任务 scratch 绑定（须先经隔离任务建立 scratch）。');
    }
    assertArtifactRequestWithinScratch(request, options.scratchRoot, workspaceDir);
  }
  // 交接解析（零个或多个候选上游均失败关闭）。
  const { handoff, prd } = resolveHandoffUpstream({
    flows,
    handoffs,
    handoffToken: options.handoffToken,
  });
  if (handoff.ownerOpenId !== identity.ownerOpenId) {
    throw new Error('架构交接码不属于当前任务发起人，拒绝创建架构制品。');
  }
  // 上游漂移检查：交接锚定的 PRD 版本必须仍然与磁盘一致（复用 G2/G3 守卫）。
  await assertArtifactStillMatchesApproval({
    flow: { status: prd.status, content_digest: prd.content_digest, request: prd.request, artifact_kind: prd.artifact_kind },
    workspaceDir: options.resolvePrdWorkspaceDir({ prdSessionId: handoff.prdSessionId }),
  });

  let contentDigest: string | null = null;
  let contentSources: ContentSource[];
  if (request.deliveryMode === 'local') {
    const snapshot = await readArchitectureArtifactSnapshot(workspaceDir, request);
    contentDigest = snapshot.digest.digest;
    contentSources = snapshot.digest.content_sources;
    for (const text of snapshot.texts) {
      try {
        extractKnowledgeCitations(text);
      } catch (error) {
        if (error instanceof KnowledgeCitationParseError) {
          throw new Error(`架构设计包含畸形的知识引用令牌，提交失败关闭：${error.message}`);
        }
        throw error;
      }
    }
  } else {
    contentSources = [{ kind: 'lark', file_token: productDocumentToken(request.documentUrl) ?? request.documentUrl }];
  }

  const upstream: ArchitectureUpstream = {
    prdToken: prd.token,
    prdDigest: prd.content_digest!,
    ...(prd.approvedAt ? { approvedAt: prd.approvedAt } : {}),
    ...(prd.approvalMessageId ? { approvalMessageId: prd.approvalMessageId } : {}),
    prdTaskId: handoff.prdTaskId,
    prdSessionId: handoff.prdSessionId,
    knowledgeRefs: structuredClone(prd.knowledge_refs ?? []),
    knowledgeState: prd.knowledge_state ?? null,
  };
  const flow = flows.create({
    ...identity,
    request,
    artifact_kind: 'architecture',
    content_digest: contentDigest,
    digest_algorithm: 'canonical-sha256-v1',
    content_sources: contentSources,
    knowledge_refs: upstream.knowledgeRefs,
    knowledge_state: upstream.knowledgeState,
    upstream,
  });
  // flow 创建成功后才消费交接（单次有效；失败路径不消耗 capability）。
  const consumed = handoffs.consume(options.handoffToken, {
    taskId: identity.taskId,
    ownerOpenId: identity.ownerOpenId,
  });
  if (!consumed) {
    // 并发窗口内交接已被他人消费/关闭：**作废**刚创建的 flow（置 invalidated，
    // 不是事务回滚——它会在历史中留下一条作废记录）。两步之间进程崩溃可能
    // 留下 open 交接码与已创建 flow 并存；持久化交接与原子消费属 W6 生产门禁。
    flows.invalidate(flow.token, '架构交接在创建窗口内被并发使用或级联关闭，制品作废');
    throw new Error('架构交接码在创建过程中失效（可能被并发使用或级联关闭），请重新发起交接。');
  }
  return flow;
}

/**
 * 架构制品的知识引用核验（G1 闭包）：与产品制品不同，架构 flow 的 refs 是
 * 从上游 PRD **继承**的，因此台账绑定沿用上游 PRD 的任务/会话；正文引用是
 * 单向约束——架构设计里出现的每个 `[[kb:]]` 引用必须落在继承范围内（同
 * system/snapshot/对象、revision 一致），但不要求设计文档复述 PRD 的全部引用。
 */
export function verifyArchitectureCitations(options: {
  artifactTexts: readonly string[];
  declaredRefs: readonly KnowledgeRef[];
  ledger: KnowledgePrefetchLedger;
  upstream: ArchitectureUpstream;
}): { ok: true } | { ok: false; reason: string } {
  const refCheck = options.ledger.verifyReferences(options.declaredRefs, {
    taskId: options.upstream.prdTaskId,
    sessionId: options.upstream.prdSessionId,
  });
  if (!refCheck.ok) {
    return { ok: false, reason: `继承的知识引用与上游预取台账不一致：${refCheck.reason}` };
  }
  for (const text of options.artifactTexts) {
    let parsed;
    try {
      parsed = extractKnowledgeCitations(text);
    } catch (error) {
      if (error instanceof KnowledgeCitationParseError) {
        return { ok: false, reason: `架构设计正文包含畸形的知识引用令牌：${error.message}` };
      }
      throw error;
    }
    for (const citation of parsed) {
      const candidates = options.declaredRefs.filter((ref) =>
        ref.system_id === citation.system_id
        && ref.snapshot_ref === citation.snapshot_ref
        && ref.object_ids.includes(citation.object_id));
      if (candidates.length === 0) {
        return {
          ok: false,
          reason: `架构设计引用 ${citation.system_id}/${citation.object_id}@${citation.snapshot_ref} 不在上游产品方案继承的知识引用范围内，确认被拒绝`,
        };
      }
      const declaredRevision = candidates[0].object_revisions?.[citation.object_id];
      if (declaredRevision !== undefined && citation.revision !== undefined && citation.revision !== declaredRevision) {
        return {
          ok: false,
          reason: `架构设计引用 ${citation.object_id} 的 revision=${citation.revision} 与继承绑定 revision=${declaredRevision} 不一致`,
        };
      }
    }
  }
  return { ok: true };
}

/**
 * 架构确认前的上游门禁：PRD 必须仍然唯一、已批准、版本摘要与交接锚定一致，
 * 且其文件当前仍与批准摘要一致（完整回读重算）。任何一步失败都拒绝确认——
 * PRD 确认不能被自动解释成架构批准，PRD 失效必须拦下架构确认。
 */
export async function verifyArchitectureUpstreamAtApproval(options: {
  flow: Pick<ProductSpecFlow, 'upstream'>;
  flows: Pick<ProductSpecFlowStore, 'get'>;
  prdWorkspaceDir: string | undefined;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const upstream = options.flow.upstream;
  if (!upstream) {
    return { ok: false, reason: '这份架构设计没有绑定上游产品方案（服务端交接缺失），不能确认。' };
  }
  const prd = options.flows.get(upstream.prdToken);
  if (!prd || (prd.artifact_kind ?? 'prd') !== 'prd' || prd.status !== 'approved' || prd.content_digest !== upstream.prdDigest) {
    return { ok: false, reason: '上游产品方案已失效或版本已变化（需重新确认 PRD 并重新交接），这份架构设计不能确认。' };
  }
  try {
    await assertArtifactStillMatchesApproval({
      flow: { status: prd.status, content_digest: prd.content_digest, request: prd.request, artifact_kind: prd.artifact_kind },
      workspaceDir: options.prdWorkspaceDir,
    });
  } catch (error) {
    return { ok: false, reason: `上游产品方案无法完整回读或已漂移：${(error as Error).message}` };
  }
  return { ok: true };
}
