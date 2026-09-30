import { invalidateAuthorizationsForPrd, type CodingAuthorizationStore } from '../core/coding-authorization.js';
import type { ArtifactInvalidationHookInput, ArtifactInvalidationHooks } from './artifact-monitor.js';

/**
 * ArtifactMonitor → CodingAuthorization 的失效级联适配（T-021/T-023 模型侧）：
 * PRD 失效按其 token 级联；架构失效按其上游 PRD 级联（授权统一绑定在 PRD
 * 维度，架构授权的 upstream 同样命中）。仅做数据模型迁移；进行中任务的
 * abort 属 T-023，本批不接线。
 *
 * 生产未启动监测调度：该钩子只在 fixture/未来接线时使用。
 */
export function createAuthorizationInvalidationHook(options: {
  authorizations: CodingAuthorizationStore;
}): ArtifactInvalidationHooks {
  return {
    onInvalidated: (input: ArtifactInvalidationHookInput) => {
      const prdToken = input.cascadeOfPrdToken
        ?? ((input.flow.artifact_kind ?? 'prd') === 'prd'
          ? input.flow.token
          : input.flow.upstream?.prdToken);
      if (!prdToken) return;
      invalidateAuthorizationsForPrd({
        store: options.authorizations,
        prdToken,
        reason: input.cascadeOfPrdToken
          ? `上游产品方案失效，授权级联失效（${input.reason}）`
          : `被授权制品失效，授权级联失效（${input.reason}）`,
      });
    },
  };
}
