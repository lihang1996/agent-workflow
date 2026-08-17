import { resolve } from 'node:path';

export type BotRole =
  | 'ceo'
  | 'pm'
  | 'architect'
  | 'dev'
  | 'qa'
  | 'reviewer'
  | 'runtime_auditor'
  | 'final_reviewer';

export interface BotConfig {
  /** 稳定 ID，用于会话隔离，如 dev / qa */
  id: string;
  role: BotRole;
  name: string;
  appId: string;
  appSecret: string;
  /** Bot 默认工作目录（可被话题 /workdir 覆盖） */
  workdir?: string;
}

interface RoleSpec {
  id: string;
  role: BotRole;
  envPrefix: string;
  defaultName: string;
}

const ROLE_SPECS: RoleSpec[] = [
  { id: 'ceo', role: 'ceo', envPrefix: 'BOT_CEO', defaultName: 'CEO助手' },
  { id: 'pm', role: 'pm', envPrefix: 'BOT_PM', defaultName: '产品经理' },
  { id: 'architect', role: 'architect', envPrefix: 'BOT_ARCH', defaultName: '架构师' },
  { id: 'dev', role: 'dev', envPrefix: 'BOT_DEV', defaultName: '开发工程师' },
  { id: 'qa', role: 'qa', envPrefix: 'BOT_QA', defaultName: '测试工程师' },
  { id: 'reviewer', role: 'reviewer', envPrefix: 'BOT_REVIEWER', defaultName: '代码评审' },
  { id: 'runtime_auditor', role: 'runtime_auditor', envPrefix: 'BOT_RUNTIME_AUDITOR', defaultName: '运行时审计' },
  { id: 'final_reviewer', role: 'final_reviewer', envPrefix: 'BOT_FINAL_REVIEWER', defaultName: '最终审查' },
];

/** 读取非空环境变量。 */
function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/** 按角色前缀加载单个 Bot；缺凭证则跳过。 */
function loadRole(spec: RoleSpec): BotConfig | undefined {
  let appId = readEnv(`${spec.envPrefix}_APP_ID`);
  let appSecret = readEnv(`${spec.envPrefix}_APP_SECRET`);

  // 兼容旧配置：开发 bot 可回退到 BOT_A_*
  if (spec.id === 'dev') {
    appId ??= readEnv('BOT_A_APP_ID');
    appSecret ??= readEnv('BOT_A_APP_SECRET');
  }

  if (!appId || !appSecret) return undefined;

  const workdirRaw = readEnv(`${spec.envPrefix}_WORKDIR`);
  return {
    id: spec.id,
    role: spec.role,
    name: readEnv(`${spec.envPrefix}_NAME`) ?? spec.defaultName,
    appId,
    appSecret,
    ...(workdirRaw ? { workdir: resolve(workdirRaw) } : {}),
  };
}

/** 从环境变量加载已配置的 Bot 列表（缺凭证的角色会跳过）。 */
export function loadBotConfigs(): BotConfig[] {
  const bots = ROLE_SPECS
    .map(loadRole)
    .filter((bot): bot is BotConfig => bot != null);

  // 去重：同一 appId 只保留第一次出现的角色
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
