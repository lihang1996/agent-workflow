/**
 * Bot 角色配置：从 .env 加载飞书应用凭证。
 *
 * 项目定义了 8 个角色，每个角色对应一个飞书应用（Bot）。
 * 每个飞书应用需要单独开「事件长连接」收消息，并拉进同一个群。
 *
 * 角色列表：
 *   CEO     → 团队统一入口，收自然语言目标自动启动流水线
 *   PM      → 产品经理，需求澄清 + Spec
 *   架构师   → 技术方案设计（只设计不实现）
 *   开发     → 代码实现
 *   评审     → 代码审查
 *   QA      → 测试验收
 *   运行时审计 → 运行时边界探测（可选，回退 QA）
 *   最终审查   → 交付前终审（可选，回退评审）
 *
 * 配置规则：
 * - 凭证只放 .env（已 gitignore），绝不硬编码、绝不提交
 * - config/bots.json 不被运行时读取，只认 .env 的 BOT_*
 * - 每个角色至少需要 <PREFIX>_APP_ID 和 <PREFIX>_APP_SECRET
 * - 开发 Bot 兼容旧变量 BOT_A_*
 */

import { resolve } from 'node:path';

/**
 * Bot 角色枚举。
 * 对应流水线的逻辑角色，用于会话隔离和权限判断。
 */
export type BotRole =
  | 'ceo'
  | 'pm'
  | 'architect'
  | 'dev'
  | 'qa'
  | 'reviewer'
  | 'runtime_auditor'
  | 'final_reviewer';

/**
 * 单个 Bot 的完整配置。
 * 由 loadBotConfigs() 从 .env 加载。
 */
export interface BotConfig {
  /** 稳定 ID，用于会话隔离，如 'dev' / 'qa' / 'ceo' */
  id: string;
  /** 逻辑角色（与 id 一一对应，但独立于飞书应用身份） */
  role: BotRole;
  /** 显示名（飞书卡片标题里用），如"开发工程师" */
  name: string;
  /** 飞书应用 App ID */
  appId: string;
  /** 飞书应用 App Secret */
  appSecret: string;
  /** Bot 默认工作目录（可被话题 /workdir 覆盖） */
  workdir?: string;
}

/**
 * 角色规格定义：环境变量前缀 + 默认显示名。
 * 用于 loadRole() 时知道该读哪些环境变量。
 */
interface RoleSpec {
  id: string;
  role: BotRole;
  /** .env 中的环境变量前缀，如 BOT_DEV / BOT_QA */
  envPrefix: string;
  /** 默认显示名（用户未设 BOT_*_NAME 时用） */
  defaultName: string;
}

/**
 * 8 个角色的完整规格定义。
 * 顺序固定：CEO → PM → 架构师 → 开发 → QA → 评审 → 运行时审计 → 最终审查
 */
const ROLE_SPECS: RoleSpec[] = [
  { id: 'ceo',            role: 'ceo',             envPrefix: 'BOT_CEO',            defaultName: 'CEO助手' },
  { id: 'pm',             role: 'pm',              envPrefix: 'BOT_PM',             defaultName: '产品经理' },
  { id: 'architect',      role: 'architect',       envPrefix: 'BOT_ARCH',           defaultName: '架构师' },
  { id: 'dev',            role: 'dev',             envPrefix: 'BOT_DEV',            defaultName: '开发工程师' },
  { id: 'qa',             role: 'qa',              envPrefix: 'BOT_QA',             defaultName: '测试工程师' },
  { id: 'reviewer',       role: 'reviewer',        envPrefix: 'BOT_REVIEWER',      defaultName: '代码评审' },
  { id: 'runtime_auditor',role: 'runtime_auditor', envPrefix: 'BOT_RUNTIME_AUDITOR',defaultName: '运行时审计' },
  { id: 'final_reviewer', role: 'final_reviewer',  envPrefix: 'BOT_FINAL_REVIEWER',defaultName: '最终审查' },
];

/**
 * 读取非空环境变量。
 * @param name - 环境变量名
 * @returns trim 后的值；空字符串返回 undefined
 */
function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/**
 * 按角色规格加载单个 Bot 的配置。
 *
 * 读取 <PREFIX>_APP_ID / <PREFIX>_APP_SECRET / <PREFIX>_NAME / <PREFIX>_WORKDIR。
 * 开发 Bot 还兼容旧变量 BOT_A_*（向后兼容）。
 *
 * @returns BotConfig 或 undefined（缺凭证时跳过该角色）
 */
function loadRole(spec: RoleSpec): BotConfig | undefined {
  let appId = readEnv(`${spec.envPrefix}_APP_ID`);
  let appSecret = readEnv(`${spec.envPrefix}_APP_SECRET`);

  // 兼容旧配置：开发 bot 可回退到 BOT_A_*
  if (spec.id === 'dev') {
    appId ??= readEnv('BOT_A_APP_ID');
    appSecret ??= readEnv('BOT_A_APP_SECRET');
  }

  // 缺凭证 → 跳过该角色（不阻断启动）
  if (!appId || !appSecret) return undefined;

  // 可选的工作目录配置
  const workdirRaw = readEnv(`${spec.envPrefix}_WORKDIR`);

  return {
    id: spec.id,
    role: spec.role,
    // 显示名：用户可设 BOT_*_NAME 覆盖，否则用默认名
    name: readEnv(`${spec.envPrefix}_NAME`) ?? spec.defaultName,
    appId,
    appSecret,
    // 工作目录转绝对路径
    ...(workdirRaw ? { workdir: resolve(workdirRaw) } : {}),
  };
}

/**
 * 从环境变量加载已配置的 Bot 列表。
 *
 * 遍历 8 个角色规格，逐个尝试加载。
 * 缺凭证的角色会被跳过（返回 undefined 被 filter 掉）。
 * 同一 appId 的多个角色只保留第一次出现的（去重）。
 *
 * @returns BotConfig[] — 至少需要 1 个，否则 index.ts 会退出
 */
export function loadBotConfigs(): BotConfig[] {
  const bots = ROLE_SPECS
    .map(loadRole)                                    // 逐个加载
    .filter((bot): bot is BotConfig => bot != null);  // 过滤掉缺凭证的

  // 去重：同一 appId 只保留第一次出现的角色
  // 场景：用户把同一个飞书应用配置了两个角色（复用凭证）
  const seen = new Set<string>();
  const unique: BotConfig[] = [];
  for (const bot of bots) {
    if (seen.has(bot.appId)) {
      console.warn(`[配置] 跳过重复 appId 的 bot: ${bot.id}`);
      continue;
    }
    seen.add(bot.appId);
    unique.push(bot);
  }
  return unique;
}
