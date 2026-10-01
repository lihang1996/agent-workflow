import type { AppRuntime } from './runtime.js';
import type { BotConfig } from '../core/bot-registry.js';
import type { KnowledgeRef } from '../core/product-spec.js';
import type { SourceContextBinding } from '../core/source-context-grant.js';
export function sourceBinding(config: BotConfig, identity: {
    taskId: string;
    sessionId: string;
    sessionVersion: number;
    ownerOpenId: string;
    ownerUnionId?: string;
}, workspace: string): Omit<SourceContextBinding, 'systemId'> {
    return { taskId: identity.taskId, sessionId: identity.sessionId, sessionVersion: identity.sessionVersion,
        botId: config.id, principalId: identity.ownerUnionId ?? identity.ownerOpenId, role: config.role, workspaceRealpath: workspace };
}
export async function prefetchSourceContext(runtime: AppRuntime, config: BotConfig, binding: Omit<SourceContextBinding, 'systemId'>, requirement: string): Promise<string> {
    if (!runtime.sourceContexts) {
        if (config.kbSystems?.length)
            throw new Error('此 Bot 配置了知识库，但可信主进程消费通道尚未配置，不能生成无依据的方案');
        return '';
    }
    const texts: string[] = [];
    for (const systemId of config.kbSystems ?? []) {
        const scoped = { ...binding, systemId };
        const grant = await runtime.sourceContexts.issue(scoped, requirement);
        texts.push(await runtime.sourceContexts.read(grant.grantId, scoped));
        if (texts.reduce((bytes, text) => bytes + Buffer.byteLength(text), 0) > 524288)
            throw new Error('多系统知识上下文超出预算，请缩小范围');
    }
    return texts.length ? '\n\n' + texts.join('\n\n') : '';
}
export function sourceSubmission(runtime: AppRuntime, binding: Omit<SourceContextBinding, 'systemId'>) {
    const host = runtime.sourceContexts;
    return host ? { knowledge: { refs: host.references(binding), state: 'ok' as const },
        verifyCitations: ({ artifactTexts, declaredRefs }: {
            artifactTexts: readonly string[];
            declaredRefs: KnowledgeRef[];
        }) => host.verifyCitations(artifactTexts, declaredRefs, binding) } : {};
}
