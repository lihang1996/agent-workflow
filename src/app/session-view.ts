import { getCliAdapter } from "../cli/registry.js";
import type { BotConfig } from "../core/bot-registry.js";
import type { Session, SessionManager } from "../core/session-manager.js";
import { describeEffectiveModel } from "./execution-model.js";

const STATUS_LABELS: Record<Session["status"], string> = {
  creating: "创建中",
  active: "执行中",
  idle: "空闲",
  closed: "已关闭",
};

/**
 * /status 视图（A05 接入生效模型视图）：bot 配置可取到时展示
 * 「角色声明 → 个人默认 → 最终参数」三层；会话级信息（话题级模型声明）
 * 在 Session 上不存在，这里只补充当前原生会话的实际模型绑定。
 */
export function formatSessionStatus(
  session: Session,
  botId: string,
  bot?: Pick<BotConfig, "defaultCliId" | "modelOverrides">,
): string {
  const adapter = getCliAdapter(session.cliId);
  return [
    `机器人：${botId}`,
    `会话：${session.id}`,
    `状态：${STATUS_LABELS[session.status]}`,
    `执行引擎：${adapter.displayName}`,
    `CLI 会话：${session.cliSessionId ?? "(尚未建立)"}`,
    ...(bot
      ? [describeEffectiveModel(bot, {
          cliId: session.cliId,
          ...(session.cliModelSelection !== undefined
            ? { boundSelection: session.cliModelSelection }
            : {}),
        })]
      : []),
    `工作目录：${session.workspaceDir}`,
    `话题：${session.threadId}`,
    `更新时间：${session.updatedAt}`,
  ].join("\n");
}

export async function markSessionIdle(
  sessions: SessionManager,
  sessionId: string,
  log: (message: string) => void = console.log,
): Promise<void> {
  if (sessions.get(sessionId)?.status !== "active") return;
  await sessions.transition(sessionId, "idle");
  log(`[会话] id=${sessionId} status=idle`);
}
