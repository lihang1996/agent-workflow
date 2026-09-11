import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BotConfig } from './bot-registry.js';
import { appToolsForBot, type AppToolName } from './app-tool-policy.js';

export interface MissingSkill {
  botId: string;
  skill: string;
  searchedPaths: string[];
}

export class TeamRegistry {
  private readonly configs = new Map<string, BotConfig>();

  constructor(
    readonly leaderBotId: string,
    configs: BotConfig[],
  ) {
    for (const config of configs) this.configs.set(config.id, config);
    if (!this.configs.has(leaderBotId)) {
      throw new Error(`Team Leader 不存在: ${leaderBotId}`);
    }
  }

  get leader(): BotConfig {
    return this.configs.get(this.leaderBotId)!;
  }

  get members(): BotConfig[] {
    return [...this.configs.values()];
  }

  get(botId: string): BotConfig | undefined {
    return this.configs.get(botId);
  }

  appToolsFor(botId: string): AppToolName[] {
    const config = this.configs.get(botId);
    if (!config) throw new Error(`团队成员不存在: ${botId}`);
    return appToolsForBot(config, this.leaderBotId);
  }

  contextFor(currentBotId: string): string {
    const current = this.configs.get(currentBotId);
    if (!current) throw new Error(`团队成员不存在: ${currentBotId}`);
    const roster = this.members.map((member) => {
      const leader = member.id === this.leaderBotId ? '（Team Leader）' : '';
      const skills = member.skills.length > 0
        ? `；Skills：${member.skills.map((skill) => `$${skill}`).join('、')}`
        : '';
      return `- ${member.id}${leader}：${member.role}${skills}`;
    });
    return [
      '你所在的 Agent 团队：',
      ...roster,
      `你当前以 ${current.id} 的身份工作。只处理交给你的职责；需要其他成员参与时，清楚说明希望交给谁以及期望结果。`,
      '团队名单中的成员都是真实的飞书 bot。CLI 内部子 Agent 适合处理临时分工，不能冒充这些长期团队成员。',
      '需要把任务交给其他成员时，使用 dispatch_task 工具，由 Agent OS 发送协作卡片并真正 @ 对方。只有 CEO 助理可以在运行时调用该工具；targetBotId 必须来自上面的团队名单，不能填写自己。',
      `当前身份可用的 Agent OS 工具：${this.appToolsFor(currentBotId).join('、') || '无'}。不能调用其他角色的工具。`,
      ...(currentBotId === this.leaderBotId ? [
        '你的职责是分析任务并分配角色。不要代替产品发起需求澄清或提交产品方案，也不要代替开发实现代码。',
        '目标、范围、用户行为或验收标准有歧义时，调用 dispatch_task 交给负责需求澄清的产品成员，由产品向用户提问。',
        '已有明确问题清单或用户已要求全部修复时，直接派给开发成员；实现方案、Git 提交策略和测试问题交给开发检查。不要重复询问用户已经确定的范围。',
        '不要自行调用 request_clarification 或 request_spec_approval，也不要声称已发送选择卡片。只能根据真实工具结果报告派发状态。',
        '派发之后你的工作就结束了：产品方案经用户确认后流程结束，后续实现由用户自行 @ 开发；成员完成的结果会直接通知用户，不会交回你转述。',
      ] : [
        '只执行当前角色的任务。完成后直接向用户给出结论；需要其他角色参与时，把未决问题和所需角色写在结果里，由用户决定下一步，不要自行调用 dispatch_task。',
      ]),
    ].join('\n');
  }

  async findMissingSkills(): Promise<MissingSkill[]> {
    const missing: MissingSkill[] = [];
    for (const config of this.members) {
      for (const skill of config.skills) {
        const searchedPaths = [
          join(config.workspaceDir, '.agents', 'skills', skill, 'SKILL.md'),
          join(config.workspaceDir, '.claude', 'skills', skill, 'SKILL.md'),
          join(homedir(), '.agents', 'skills', skill, 'SKILL.md'),
          join(homedir(), '.claude', 'skills', skill, 'SKILL.md'),
          join(homedir(), '.codex', 'skills', skill, 'SKILL.md'),
        ];
        if (!(await somePathExists(searchedPaths))) {
          missing.push({ botId: config.id, skill, searchedPaths });
        }
      }
    }
    return missing;
  }
}

async function somePathExists(paths: string[]): Promise<boolean> {
  for (const path of paths) {
    try {
      await access(path);
      return true;
    } catch {
      // 继续检查另一个项目级 Skill 目录。
    }
  }
  return false;
}
