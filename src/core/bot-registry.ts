import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { CLI_IDS, type CliId } from '../cli/types.js';
import { ModelOverridesSchema, type ModelOverrides } from './model-selection.js';
import { resolveWorkspacePath } from './workspace.js';

const ProductDeliveryModeSchema = z.enum(['local', 'lark-doc']);

export type ProductDeliveryMode = z.infer<typeof ProductDeliveryModeSchema>;

/** 制品提交阶段（服务端配置授权，work/30 T-020）：产品方案 / 架构设计。 */
export type SpecStage = 'product' | 'architecture';

export interface BotConfig {
  id: string;
  appId: string;
  appSecret: string;
  defaultCliId: CliId;
  modelOverrides: ModelOverrides;
  role: string;
  skills: string[];
  systemPrompt: string;
  workspaceDir: string;
  collaborationMaxRounds: number;
  /**
   * 可提交审批的制品阶段（T-020）：来自服务端 bots.json，不是 CLI 自报。
   * `product` → request_spec_approval；`architecture` → request_architecture_review。
   * 与 Skill 无关：`lark-doc` 只授予文档编辑能力，不授予审批提交权。
   * 配置加载后恒为数组；接口层面可选以兼容直接构造 BotConfig 的调用方。
   */
  specStages?: SpecStage[];
  /**
   * 可信知识作用域绑定（T-016/13 号 C1）：bot 可预取知识的 system 白名单。
   * 来源是服务端持有的 bots.json 配置——不是需求正文或 CLI 自报；KB_CALLER
   * 仅为审计标签。缺省/为空 = 空作用域，该 bot 的一切 KB 预取请求按越权
   * 拒绝，多系统运行态消费在 W6/W7 门禁通过前保持 blocked。
   */
  kbSystems?: string[];
}

export interface AgentOsConfig {
  teamLeaderId: string;
  defaultProductDeliveryMode: ProductDeliveryMode;
  bots: BotConfig[];
}

type Environment = Record<string, string | undefined>;

const BotSchema = z.object({
  id: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9_-]{0,31}$/,
      'bot id 只能使用小写字母、数字、连字符和下划线',
    ),
  appIdEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  appSecretEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  defaultCli: z.enum(CLI_IDS),
  modelOverrides: ModelOverridesSchema,
  role: z.string().trim().min(1),
  skills: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/))
    .optional()
    .default([]),
  workspace: z.string().trim().min(1).optional(),
  systemPrompt: z.string().trim().optional().default(''),
  collaborationMaxRounds: z.number().int().min(1).max(32).optional().default(16),
  specStages: z
    .array(z.enum(['product', 'architecture']))
    .optional()
    .default([]),
  kbSystems: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/))
    .optional()
    .default([]),
  enabled: z.boolean().optional().default(true),
});

const BotConfigFileSchema = z.object({
  teamLeader: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
  defaultProductDeliveryMode: ProductDeliveryModeSchema.optional()
    .default('lark-doc'),
  bots: z.array(BotSchema).min(1),
});

export function parseAgentOsConfig(
  input: unknown,
  env: Environment,
  baseDirectory = process.cwd(),
): AgentOsConfig {
  const parsed = BotConfigFileSchema.parse(input);
  const ids = new Set<string>();
  for (const bot of parsed.bots) {
    if (ids.has(bot.id)) throw new Error(`bot id 不能重复: ${bot.id}`);
    ids.add(bot.id);
  }

  const configs = parsed.bots
    .filter((bot) => bot.enabled)
    .map((bot) => {
      const appId = env[bot.appIdEnv]?.trim() ?? '';
      const appSecret = env[bot.appSecretEnv]?.trim() ?? '';
      if (!appId) {
        throw new Error(`bot ${bot.id} 缺少环境变量 ${bot.appIdEnv}`);
      }
      if (!appSecret) {
        throw new Error(`bot ${bot.id} 缺少环境变量 ${bot.appSecretEnv}`);
      }
      return {
        id: bot.id,
        appId,
        appSecret,
        defaultCliId: bot.defaultCli,
        modelOverrides: bot.modelOverrides,
        role: bot.role,
        skills: [...new Set(bot.skills)],
        systemPrompt: bot.systemPrompt,
        collaborationMaxRounds: bot.collaborationMaxRounds,
        specStages: [...new Set(bot.specStages)],
        kbSystems: [...new Set(bot.kbSystems)],
        workspaceDir: resolveWorkspacePath(
          bot.workspace ?? env.CLI_WORKDIR ?? env.CLAUDE_WORKDIR ?? '.',
          baseDirectory,
        ),
      };
    });
  if (configs.length === 0) throw new Error('至少需要启用一个 bot');
  const enabledIds = new Set(configs.map((config) => config.id));
  if (!enabledIds.has(parsed.teamLeader)) {
    throw new Error(`teamLeader 指向未启用的 bot: ${parsed.teamLeader}`);
  }
  return {
    teamLeaderId: parsed.teamLeader,
    defaultProductDeliveryMode: parsed.defaultProductDeliveryMode,
    bots: configs,
  };
}

export function parseBotConfigs(
  input: unknown,
  env: Environment,
  baseDirectory = process.cwd(),
): BotConfig[] {
  return parseAgentOsConfig(input, env, baseDirectory).bots;
}

export async function loadAgentOsConfig(
  filePath: string,
  env: Environment = process.env,
  baseDirectory = process.cwd(),
): Promise<AgentOsConfig> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `找不到 bot 配置文件: ${filePath}。请复制 config/bots.example.json 后填写配置。`,
      );
    }
    throw error;
  }

  try {
    return parseAgentOsConfig(JSON.parse(content), env, baseDirectory);
  } catch (error) {
    throw new Error(`bot 配置文件格式错误: ${(error as Error).message}`);
  }
}

export async function loadBotConfigs(
  filePath: string,
  env: Environment = process.env,
  baseDirectory = process.cwd(),
): Promise<BotConfig[]> {
  return (await loadAgentOsConfig(filePath, env, baseDirectory)).bots;
}

export function buildBotPrompt(
  config: Pick<BotConfig, 'role' | 'skills' | 'systemPrompt' | 'specStages'>,
  prompt: string,
  teamContext = '',
  defaultProductDeliveryMode: ProductDeliveryMode = 'lark-doc',
): string {
  const stages = config.specStages ?? [];
  // 交付规则按服务端授予的制品阶段（specStages）注入，与 Skill 无关。
  const productDeliveryPolicy = stages.includes('product')
    ? [
        '产品方案交付规则（必须遵守）：',
        `- 当前默认交付方式：${defaultProductDeliveryMode}。`,
        '- 用户明确指定本地 Markdown 或飞书云文档时，以用户本次选择覆盖默认值。',
        '- 不要为了选择交付格式单独发起澄清。',
        '- 只有实际完成了可确认的方案产物时，才调用 request_spec_approval，提交 deliveryMode 与对应字段。普通问答、状态查询和未形成新方案的讨论直接回复，不要创建确认卡。',
        '- 不能只在普通回复中罗列 deliveryMode、documentUrl、specPath 或 ticketsPath。工具调用成功后停止本轮。',
      ].join('\n')
    : '';
  const architectureStagePolicy = stages.includes('architecture')
    ? [
        '架构设计交付规则（必须遵守）：',
        '- 架构设计是独立于产品方案的制品：需求复杂或用户明确要求架构设计时，先完成架构设计再谈实现；小改动、明确的一次性修复不要强制产出架构文档。',
        '- 架构设计必须覆盖：模块划分、接口契约、数据模型与存储、迁移方案、风险与权衡、测试方案。',
        '- 只有用户从已确认产品方案卡片发起「转架构设计」并提供了架构交接码时，才调用 request_architecture_review，提交 designPath 与交接码（handoffToken）。',
        '- 不得自报产品方案编号、文档 URL 或其他上游信息充当交接码；没有有效交接码就不要提交架构审批。',
        '- 架构确认与编码授权是分开的状态：架构确认前不要开始编码；架构确认也不等于允许开发，开发授权需要用户单独发起。',
      ].join('\n')
    : '';
  const feishuOutputPolicy = [
    '飞书输出规则（必须遵守）：',
    '- 最终回复控制在 1200 个中文字符以内，先给结论，再给必要依据和下一步。',
    '- 不在回复中粘贴完整代码、长日志或整份产品文档，也不要输出 Markdown 表格。',
    '- 详细产物写入当前工作区文件。回复只提供简短摘要和文件路径。',
    '- 需要用户决策时，只有被授予 request_clarification 的成员可以发起选择卡片；老板助理不发卡，而是把问题派给对应成员。',
    '- 只在选择会实质改变结果、且任务描述或既有文档没有给出答案时才提问；一次把问题问完（最多 5 题），不要把它当成聊天，也不要重复确认用户已经明确的内容。',
    '- 发起澄清必须实际调用 request_clarification，不能只在文字中说已发送卡片。调用后停止推断，等待用户回答；工具失败时不能宣称发送成功。',
  ].join('\n');
  const sections = [
    `你的角色：${config.role}`,
    config.systemPrompt.trim(),
    teamContext.trim(),
    productDeliveryPolicy,
    architectureStagePolicy,
    config.skills.length > 0
      ? [
          '项目 Skill 加载规则（优先级不可颠倒）：',
          '- 对配置中声明的每个 Skill，先读取当前工作区 `.agents/skills/<skill>/SKILL.md`。',
          '- 上述路径不存在时，再读取当前工作区 `.claude/skills/<skill>/SKILL.md`。',
          '- 只有两个工作区路径都不存在时，才允许回退到用户级或全局同名 Skill；不得因全局 Skill 同名而跳过工作区版本。',
          `本次任务必须执行的项目 Skill：${config.skills.map((skill) => `$${skill}`).join('、')}`,
        ].join('\n')
      : '',
    feishuOutputPolicy,
    `当前任务：${prompt}`,
  ];
  return sections.filter(Boolean).join('\n\n');
}
