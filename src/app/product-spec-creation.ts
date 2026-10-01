import { readLocalArtifactSnapshot } from '../core/artifact-digest.js';
import { assertArtifactRequestWithinScratch } from '../core/isolation.js';
import { KnowledgeCitationParseError, extractKnowledgeCitations } from '../core/kb-prefetch.js';
import {
  productDocumentToken,
  type ContentSource,
  type KnowledgeRef,
  type KnowledgeUsageState,
  type ProductSpecFlow,
  type ProductSpecFlowStore,
  type ProductSpecRequest,
} from '../core/product-spec.js';
import type { CollaborationOrigin } from '../core/collaboration.js';

/**
 * 服务端制品创建（W5 返修拆出的共享路径；二轮强化单次受控读取）：
 * message-handler 的直接提交与 clarification-runner 的澄清后提交走同一个
 * 摘要/引用绑定流程。
 *
 * 本地模式：**一次** `readLocalArtifactSnapshot` 同时完成完整性校验、manifest
 * 摘要计算与同批正文读取——绑定的 digest 与引用核验的正文来自同一次读取
 *（含读中变化失败关闭），不存在「摘要读 A、正文读 B」的窗口。任何失败
 *（缺失/符号链接/读取失败/读中变化/畸形令牌/引用核验不过）→ 整个提交失败
 * 关闭，不生成确认卡。飞书模式：记录 lark content_source、digest=null
 *（U-3 未核验，G1 拒绝确认）。
 *
 * 引用核验（work/44-4/45-3）：制品正文出现 `[[kb:` 候选（合法或畸形）或携带
 * 声明的服务端 refs 时，必须提供 verifyCitations 并通过（台账 + 任务/会话/
 * 作用域绑定 + 正文与声明同一 snapshot/object/revision 双向一致）；畸形令牌
 * 即使有核验通道也失败关闭；无核验通道（生产现状）→ 失败关闭。
 * knowledge 仅由服务端持有；生产运行态不注入（KNOWLEDGE_RUNTIME_GATE 保持
 * blocked），该参数只在本地可信接线测试中出现。
 */
export async function createBoundProductSpecFlow(options: {
  store: ProductSpecFlowStore;
  workspaceDir: string;
  /**
   * T-022/W6b（119 号 P1-4）：本地交付**必填**——任务 scratch 相对根；缺失即
   * 失败关闭（生产调用方经 requireScratchRootForSubmission 获取）。
   */
  scratchRoot?: string;
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
  request: ProductSpecRequest;
  knowledge?: { refs: KnowledgeRef[]; state: KnowledgeUsageState | null };
  /** 服务端引用核验闭包（绑定台账与任务/会话）；引用存在时必须提供。 */
  verifyCitations?: (input: {
    artifactTexts: readonly string[];
    declaredRefs: KnowledgeRef[];
  }) => { ok: true } | { ok: false; reason: string } | Promise<{ ok: true } | { ok: false; reason: string }>;
  /** 测试注入：读取与稳定性复核之间触发「读取过程中变化」时序。 */
  artifactReadHook?: () => Promise<void>;
}): Promise<ProductSpecFlow> {
  const { store, workspaceDir, identity, request } = options;
  if (request.deliveryMode === 'local') {
    if (!options.scratchRoot) {
      throw new Error('本地制品提交失败关闭：缺少任务 scratch 绑定（须先经隔离任务建立 scratch）。');
    }
    assertArtifactRequestWithinScratch(request, options.scratchRoot, workspaceDir);
  }
  let contentDigest: string | null = null;
  let contentSources: ContentSource[];
  if (request.deliveryMode === 'local') {
    // 单次受控读取：完整性校验、摘要与正文同批（读中变化由快照内部失败关闭）。
    const snapshot = await readLocalArtifactSnapshot(workspaceDir, request, {
      afterRead: options.artifactReadHook ? async () => options.artifactReadHook!() : undefined,
    });
    contentDigest = snapshot.digest.digest;
    contentSources = snapshot.digest.content_sources;
    // 提交点即核验实际引用：任何 [[kb: 候选（含畸形）或声明的 refs 都必须可核验。
    let citationCount = 0;
    for (const text of snapshot.texts) {
      try {
        citationCount += extractKnowledgeCitations(text).length;
      } catch (error) {
        if (error instanceof KnowledgeCitationParseError) {
          throw new Error(`方案包含畸形的知识引用令牌，提交失败关闭：${error.message}`);
        }
        throw error;
      }
    }
    const declaredRefs = options.knowledge?.refs ?? [];
    if (citationCount > 0 || declaredRefs.length > 0) {
      if (!options.verifyCitations) {
        throw new Error('方案包含知识引用（或声明了服务端知识引用），但引用核验通道不可用：提交失败关闭，不生成确认卡。');
      }
      const verified = await options.verifyCitations({ artifactTexts: snapshot.texts, declaredRefs });
      if (!verified.ok) {
        throw new Error(`方案知识引用核验未通过，提交失败关闭：${verified.reason}`);
      }
    }
  } else {
    contentSources = [{ kind: 'lark', file_token: productDocumentToken(request.documentUrl) ?? request.documentUrl }];
  }
  return store.create({
    ...identity,
    request,
    content_digest: contentDigest,
    digest_algorithm: 'canonical-sha256-v1',
    content_sources: contentSources,
    knowledge_refs: options.knowledge?.refs ?? [],
    knowledge_state: options.knowledge?.state ?? null,
  });
}
