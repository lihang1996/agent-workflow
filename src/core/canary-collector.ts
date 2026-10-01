import { appendFileSync } from 'node:fs';
import type { CanaryCommandExecution } from './canary-verdict.js';

/**
 * G-W6b-CANARY 事件收集器（A01 二轮重写，166 号返工批）。
 *
 * 旧 runner 的缺陷：逐行解析**消耗** stdoutBuffer（slice 掉已解析行），结束时
 * 只把剩余尾巴落盘——正常完整 JSONL 行全部丢失，verdict 无法对照实际命令；
 * 尾部无换行的最后一行也永不解析。超时/终止路径没有有限时间落盘证据的保证。
 *
 * 本模块把「原始证据保存」与「事件解析」拆开：
 * - 原始 stdout 每个 chunk **先**写入独立 sink（文件追加，逐字节保留），
 *   解析缓冲是另一份状态，永不影响证据；
 * - finish() 处理无换行尾行（尝试解析并计入 pendingPartial 元数据）；
 * - replayCanaryRawStream 用同一解析器从保存的原始流**独立重判**（测试断言
 *   重放事件与当次判定输入一致）；
 * - awaitCloseWithDeadline 给 runner 的收尾一个有界等待：close 不来也在
 *   期限后返回 closeArrived=false，调用方据此落盘 fail 证据并退出——总时间
 *   有界，不会悬挂。
 */

/** codex exec --json 事件（只取本探针关心的字段的宽松视图）。 */
export interface CodexEvent {
  type?: string;
  item?: {
    type?: string;
    command?: string;
    exit_code?: number | null;
    aggregated_output?: string;
  } & Record<string, unknown>;
}

/** 工具结果类事件白名单：哨兵泄漏扫描只看这些（agent_message/reasoning 不算）。 */
export const TOOL_RESULT_ITEM_TYPES = new Set(['command_execution', 'mcp_tool_call', 'file_change', 'web_search']);

/** 原始证据 sink：每个 chunk 到达即写入，与解析缓冲完全分离。 */
export interface CanaryRawSink {
  append(chunk: string): void;
}

/** 文件 sink（追加写；0600 建档）。runner 用它把原始流保存到 run 证据目录。 */
export function createFileRawSink(filePath: string): CanaryRawSink {
  return {
    append(chunk: string): void {
      appendFileSync(filePath, chunk, { encoding: 'utf8', mode: 0o600 });
    },
  };
}

export interface CanaryCollectedEvents {
  commands: CanaryCommandExecution[];
  toolResultTexts: string[];
  engineCompleted: boolean;
  /** 原始流字节数（UTF-8 码点计数；证据摘要仍以原文件字节为准）。 */
  rawLength: number;
  /** 解析过的 JSONL 行数（含 finish 处理的无换行尾行）。 */
  lineCount: number;
  /** 非 JSON 行原文（引擎前导文本等；证据元数据记录，不参与判定）。 */
  invalidLines: string[];
  /** finish 时无换行尾行的原文（已尝试解析；无论成败都保留证据元数据）。 */
  pendingPartial: string | null;
}

export class CanaryEventCollector {
  private buffer = '';
  private readonly events: CanaryCollectedEvents = {
    commands: [],
    toolResultTexts: [],
    engineCompleted: false,
    rawLength: 0,
    lineCount: 0,
    invalidLines: [],
    pendingPartial: null,
  };

  constructor(private readonly sink: CanaryRawSink) {}

  ingestChunk(chunk: string): void {
    // 证据优先：原始 chunk 先落 sink，解析失败也绝不影响已保存证据。
    this.sink.append(chunk);
    this.events.rawLength += chunk.length;
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line) this.ingestLine(line);
      newlineIndex = this.buffer.indexOf('\n');
    }
  }

  /** 收尾：处理无换行的尾行（尝试解析；成败都记录，不再有「永不解析」的行）。 */
  finish(): void {
    if (this.buffer.length === 0) return;
    const line = this.buffer.trim();
    this.events.pendingPartial = this.buffer;
    this.buffer = '';
    if (line) this.ingestLine(line);
  }

  get collected(): CanaryCollectedEvents {
    return this.events;
  }

  private ingestLine(line: string): void {
    this.events.lineCount += 1;
    let event: CodexEvent;
    try {
      event = JSON.parse(line) as CodexEvent;
    } catch {
      this.events.invalidLines.push(line);
      return; // 非 JSONL 行（引擎前导文本）忽略；证据以结构化事件为准。
    }
    const item = event.item;
    if (event.type === 'turn.completed') this.events.engineCompleted = true;
    if (event.type !== 'item.completed' || !item) return;
    if (item.type === 'command_execution') {
      this.events.commands.push({
        command: item.command ?? '',
        exitCode: typeof item.exit_code === 'number' ? item.exit_code : null,
        aggregatedOutput: item.aggregated_output ?? '',
      });
      this.events.toolResultTexts.push(item.command ?? '', item.aggregated_output ?? '');
    } else if (item.type && TOOL_RESULT_ITEM_TYPES.has(item.type)) {
      // 其他工具事件（apply_patch/MCP/搜索）也进泄漏扫描域。
      this.events.toolResultTexts.push(JSON.stringify(item));
    }
  }
}

/**
 * 从保存的原始流独立重放（同一解析器；测试用它断言「保存的证据可独立重判」：
 * 重放得到的 commands/toolResultTexts/engineCompleted 与当次判定输入一致）。
 */
export function replayCanaryRawStream(rawText: string): CanaryCollectedEvents {
  const collector = new CanaryEventCollector({ append: (): void => undefined });
  collector.ingestChunk(rawText);
  collector.finish();
  return collector.collected;
}

/**
 * 有界等待子进程 close：deadline 内收到 close ⇒ exitCode + closeArrived=true；
 * 期限已过仍未 close ⇒ { exitCode: null, closeArrived: false }，调用方必须
 * 据此落盘失败证据并退出（总时间有界；不再无限等待 close）。
 */
export function awaitCloseWithDeadline(
  child: { once(event: 'close', listener: (code: number | null) => void): unknown },
  deadlineMs: number,
): Promise<{ exitCode: number | null; closeArrived: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ exitCode: null, closeArrived: false });
    }, deadlineMs);
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code, closeArrived: true });
    });
  });
}
