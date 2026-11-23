/**
 * 《炉石传说》MSP World（移植自 cortico-world-hearthstone）：
 * - 增量监听 Power.log 对局日志
 * - 工具：hearthstone_state, hearthstone_advice
 * - 信号：hs.match_start, hs.turn_start, hs.match_end
 */
import * as fs from "node:fs";
import type { MSPNode } from "../shared/msp.ts";
import { computeAdvice, HearthstoneLogParser } from "./parser.ts";

export interface HearthstoneConfig {
  logPath?: string;
  pollIntervalMs?: number;
}

export class HearthstoneWorld {
  private readonly logPath: string;
  private readonly pollIntervalMs: number;
  private readonly parser = new HearthstoneLogParser();
  private node: MSPNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private offset = 0;

  constructor(config: HearthstoneConfig = {}) {
    this.logPath = config.logPath ?? "";
    this.pollIntervalMs = config.pollIntervalMs ?? 1000;
  }

  attach(node: MSPNode): void {
    this.node = node;
    node.declareSignal("hs.match_start", "炉石对局开始");
    node.declareSignal("hs.turn_start", "炉石回合切换");
    node.declareSignal("hs.match_end", "炉石对局结束");

    node.tool(
      "hearthstone_state",
      "读取当前炉石对局局面：双方英雄血量护甲、场面随从、手牌与法力水晶",
      () => {
        this.pollOnce();
        return this.parser.state() as unknown as Record<string, unknown>;
      },
      { type: "object", additionalProperties: false, properties: {} },
    );

    node.tool(
      "hearthstone_advice",
      "计算本回合可出牌、场攻斩杀线与对面下回合威胁",
      () => {
        this.pollOnce();
        return computeAdvice(this.parser.state());
      },
      { type: "object", additionalProperties: false, properties: {} },
    );

    node.skill({
      name: "turn_advisor",
      summary: "先读取当前完整对局局面，再计算手牌、斩杀与交换建议",
      whenToUse: "自己回合开始或玩家询问这回合怎么打、能不能斩杀时使用",
      toolsUsed: ["hearthstone_state", "hearthstone_advice"],
    });
  }

  start(): void {
    if (this.timer) return;
    this.pollOnce();
    if (this.pollIntervalMs > 0) {
      this.timer = setInterval(() => this.pollOnce(), this.pollIntervalMs);
      this.timer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  feedRawLines(lines: readonly string[]): void {
    const events = this.parser.feedLines(lines);
    for (const ev of events) {
      this.node?.publish(ev.type, ev.data);
    }
  }

  pollOnce(): void {
    if (!this.logPath || !fs.existsSync(this.logPath)) return;
    const stat = fs.statSync(this.logPath);
    if (stat.size < this.offset) this.offset = 0;
    if (stat.size === this.offset) return;

    const fd = fs.openSync(this.logPath, "r");
    try {
      const len = stat.size - this.offset;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, this.offset);
      this.offset = stat.size;
      this.feedRawLines(buf.toString("utf8").split(/\r?\n/));
    } finally {
      fs.closeSync(fd);
    }
  }
}
