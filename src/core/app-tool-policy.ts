import type { BotConfig } from './bot-registry.js';
import { ClarificationRequestSchema } from './clarification.js';
import { DispatchTaskRequestSchema } from './collaboration.js';
import {
  ARCHITECTURE_REVIEW_TOOL_NAME as ARCH_TOOL_NAME,
  ArchitectureReviewToolRequestSchema,
  ProductSpecRequestSchema,
} from './product-spec.js';

export const CLARIFICATION_TOOL_NAME = 'request_clarification';
export const PRODUCT_SPEC_TOOL_NAME = 'request_spec_approval';
export const DISPATCH_TASK_TOOL_NAME = 'dispatch_task';
export const ARCHITECTURE_REVIEW_TOOL_NAME = ARCH_TOOL_NAME;

const toolSchemas = {
  [CLARIFICATION_TOOL_NAME]: ClarificationRequestSchema,
  [PRODUCT_SPEC_TOOL_NAME]: ProductSpecRequestSchema,
  [ARCHITECTURE_REVIEW_TOOL_NAME]: ArchitectureReviewToolRequestSchema,
  [DISPATCH_TASK_TOOL_NAME]: DispatchTaskRequestSchema,
};
export type AppToolName = keyof typeof toolSchemas;

/** 注册工具的只读名单，由 toolSchemas 派生；适配器识别一律以此为单一来源。 */
export const APP_TOOL_NAMES: readonly AppToolName[] = Object.freeze(
  Object.keys(toolSchemas) as AppToolName[],
);

export function isAppToolName(value: string): value is AppToolName {
  return Object.hasOwn(toolSchemas, value);
}

/**
 * 制品提交权限按服务端配置的阶段（specStages）授予，不按 Skill 推断：
 * `lark-doc` 只说明会编辑飞书文档，不代表能提交产品/架构审批——开发 Bot 即使
 * 配了文档 Skill，也不能随时提交产品或架构审批（work/30 T-020）。
 */
export function appToolsForBot(
  config: Pick<BotConfig, 'id' | 'skills' | 'specStages'>,
  leaderBotId: string,
): AppToolName[] {
  // The leader coordinates even if product skills are accidentally configured.
  if (config.id === leaderBotId) return [DISPATCH_TASK_TOOL_NAME];
  // Every executing member may ask the user with a card; only the leader delegates instead.
  const tools: AppToolName[] = [CLARIFICATION_TOOL_NAME];
  const stages = config.specStages ?? [];
  if (stages.includes('product')) {
    tools.push(PRODUCT_SPEC_TOOL_NAME);
  }
  if (stages.includes('architecture')) {
    tools.push(ARCHITECTURE_REVIEW_TOOL_NAME);
  }
  return tools;
}

export function parseAppTools(value: string): AppToolName[] {
  if (!value) return [];
  return [...new Set(value.split(','))].map((name) => {
    if (!isAppToolName(name)) {
      throw new Error(`未知的 Agent OS 工具: ${name}`);
    }
    return name;
  });
}

export function assertAppToolAllowed(
  allowed: readonly AppToolName[],
  name: string,
): asserts name is AppToolName {
  if (!allowed.includes(name as AppToolName)) {
    throw new Error(`当前角色不能调用 ${name}。请遵循团队分工：老板助理派发任务，产品澄清需求并提交方案，开发负责架构设计与实现。`);
  }
}

export function validateAppToolCalls(
  allowed: readonly AppToolName[],
  calls: Array<{ toolName: string; input: unknown }> | undefined,
): void {
  for (const call of calls ?? []) {
    assertAppToolAllowed(allowed, call.toolName);
    const parsed = toolSchemas[call.toolName as AppToolName].safeParse(call.input);
    if (!parsed.success) {
      throw new Error(`Agent OS 工具 ${call.toolName} 参数无效: ${parsed.error.message}`);
    }
  }
}
