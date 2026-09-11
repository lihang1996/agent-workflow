import type { BotConfig } from './bot-registry.js';
import { ClarificationRequestSchema } from './clarification.js';
import { DispatchTaskRequestSchema } from './collaboration.js';
import { ProductSpecRequestSchema } from './product-spec.js';

export const CLARIFICATION_TOOL_NAME = 'request_clarification';
export const PRODUCT_SPEC_TOOL_NAME = 'request_spec_approval';
export const DISPATCH_TASK_TOOL_NAME = 'dispatch_task';

const toolSchemas = {
  [CLARIFICATION_TOOL_NAME]: ClarificationRequestSchema,
  [PRODUCT_SPEC_TOOL_NAME]: ProductSpecRequestSchema,
  [DISPATCH_TASK_TOOL_NAME]: DispatchTaskRequestSchema,
};
export type AppToolName = keyof typeof toolSchemas;

export function appToolsForBot(
  config: Pick<BotConfig, 'id' | 'skills'>,
  leaderBotId: string,
): AppToolName[] {
  // The leader coordinates even if product skills are accidentally configured.
  if (config.id === leaderBotId) return [DISPATCH_TASK_TOOL_NAME];
  // Every executing member may ask the user with a card; only the leader delegates instead.
  const tools: AppToolName[] = [CLARIFICATION_TOOL_NAME];
  if (config.skills.some((skill) => ['to-spec', 'lark-doc'].includes(skill))) {
    tools.push(PRODUCT_SPEC_TOOL_NAME);
  }
  return tools;
}

export function parseAppTools(value: string): AppToolName[] {
  if (!value) return [];
  return [...new Set(value.split(','))].map((name) => {
    if (!Object.hasOwn(toolSchemas, name)) {
      throw new Error(`未知的 Agent OS 工具: ${name}`);
    }
    return name as AppToolName;
  });
}

export function assertAppToolAllowed(
  allowed: readonly AppToolName[],
  name: string,
): asserts name is AppToolName {
  if (!allowed.includes(name as AppToolName)) {
    throw new Error(`当前角色不能调用 ${name}。请遵循团队分工：老板助理派发任务，产品澄清需求，开发处理技术问题。`);
  }
}

export function validateAppToolCalls(
  allowed: readonly AppToolName[],
  calls: Array<{ toolName: string; input: unknown }> | undefined,
): void {
  for (const call of calls ?? []) {
    assertAppToolAllowed(allowed, call.toolName);
    const parsed = toolSchemas[call.toolName].safeParse(call.input);
    if (!parsed.success) {
      throw new Error(`Agent OS 工具 ${call.toolName} 参数无效: ${parsed.error.message}`);
    }
  }
}
