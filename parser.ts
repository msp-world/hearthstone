/**
 * 《炉石传说》Power.log 增量解析器 + 斩杀/交换计算（移植自 cortico-world-hearthstone）。
 */

export interface HsEntity {
  id: number;
  cardId: string;
  name: string;
  zone: string;
  controller: number;
  cardType: string;
  atk: number;
  health: number;
  damage: number;
  armor: number;
  cost: number;
  taunt: boolean;
  divineShield: boolean;
  exhausted: boolean;
}

export interface HsMatchState {
  inMatch: boolean;
  turn: number;
  friendlyPlayerId: number;
  currentPlayerId: number;
  isMyTurn: boolean;
  mana: number;
  maxMana: number;
  friendlyHero: HsEntity | null;
  enemyHero: HsEntity | null;
  friendlyBoard: HsEntity[];
  enemyBoard: HsEntity[];
  friendlyHand: HsEntity[];
  enemyHandCount: number;
  winner?: "friendly" | "enemy" | "tie";
}

export class HearthstoneLogParser {
  private entities = new Map<number, HsEntity>();
  private inMatch = false;
  private turn = 0;
  private friendlyPlayerId = 1;
  private currentPlayerId = 1;
  private playerMana = new Map<number, { total: number; used: number }>();
  private winner: "friendly" | "enemy" | "tie" | undefined;
  private activeEntityId: number | null = null;

  feedLines(lines: readonly string[]): Array<{ type: string; data: Record<string, unknown> }> {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;

      if (line.includes("CREATE_GAME")) {
        this.entities.clear();
        this.inMatch = true;
        this.turn = 0;
        this.winner = undefined;
        this.playerMana.clear();
        this.activeEntityId = null;
        events.push({ type: "hs.match_start", data: {} });
        continue;
      }

      const fullMatch = /FULL_ENTITY - Creating ID=(\d+) CardID=(\S*)/.exec(line);
      if (fullMatch) {
        const id = Number(fullMatch[1]);
        const cardId = fullMatch[2] || "";
        const ent: HsEntity = this.entities.get(id) ?? {
          id,
          cardId,
          name: cardId || `Entity#${id}`,
          zone: "",
          controller: 0,
          cardType: "",
          atk: 0,
          health: 0,
          damage: 0,
          armor: 0,
          cost: 0,
          taunt: false,
          divineShield: false,
          exhausted: false,
        };
        if (cardId) {
          ent.cardId = cardId;
          ent.name = cardId;
        }
        this.entities.set(id, ent);
        this.activeEntityId = id;
        continue;
      }

      if (this.activeEntityId !== null && /tag=(\w+) value=(\S+)/.test(line) && !line.includes("TAG_CHANGE")) {
        const tm = /tag=(\w+) value=(\S+)/.exec(line)!;
        this.applyTag(this.activeEntityId, tm[1], tm[2]);
        continue;
      }
      this.activeEntityId = null;

      const tagChange = /TAG_CHANGE Entity=(.+?) tag=(\w+) value=(\S+)/.exec(line);
      if (tagChange) {
        const entityRaw = tagChange[1];
        const tag = tagChange[2];
        const val = tagChange[3];

        if (tag === "TURN" && entityRaw === "GameEntity") {
          this.turn = Number(val) || this.turn + 1;
          events.push({ type: "hs.turn_start", data: { turn: this.turn, currentPlayerId: this.currentPlayerId } });
          continue;
        }
        if (tag === "CURRENT_PLAYER" && val === "1") {
          const pm = /PlayerID=(\d+)/.exec(entityRaw) ?? /id=(\d+)/.exec(entityRaw);
          if (pm) {
            this.currentPlayerId = Number(pm[1]);
            events.push({ type: "hs.turn_start", data: { turn: this.turn, currentPlayerId: this.currentPlayerId } });
          }
          continue;
        }
        if (tag === "RESOURCES" || tag === "RESOURCES_USED") {
          const pm = /PlayerID=(\d+)/.exec(entityRaw) ?? /id=(\d+)/.exec(entityRaw);
          if (pm) {
            const pid = Number(pm[1]);
            const cur = this.playerMana.get(pid) ?? { total: 0, used: 0 };
            if (tag === "RESOURCES") cur.total = Number(val) || 0;
            else cur.used = Number(val) || 0;
            this.playerMana.set(pid, cur);
          }
          continue;
        }
        if (tag === "PLAYSTATE" && (val === "WON" || val === "LOST" || val === "TIED")) {
          if (this.inMatch) {
            this.inMatch = false;
            this.winner = val === "WON" ? "friendly" : val === "LOST" ? "enemy" : "tie";
            events.push({ type: "hs.match_end", data: { winner: this.winner, turn: this.turn } });
          }
          continue;
        }

        const idMatch = /\bid=(\d+)\b/.exec(entityRaw);
        if (idMatch) {
          this.applyTag(Number(idMatch[1]), tag, val);
        }
      }
    }
    return events;
  }

  private applyTag(id: number, tag: string, val: string): void {
    const ent = this.entities.get(id);
    if (!ent) return;
    switch (tag) {
      case "ZONE":
        ent.zone = val;
        break;
      case "CONTROLLER":
        ent.controller = Number(val) || 0;
        break;
      case "CARDTYPE":
        ent.cardType = val;
        break;
      case "ATK":
        ent.atk = Number(val) || 0;
        break;
      case "HEALTH":
        ent.health = Number(val) || 0;
        break;
      case "DAMAGE":
        ent.damage = Number(val) || 0;
        break;
      case "ARMOR":
        ent.armor = Number(val) || 0;
        break;
      case "COST":
        ent.cost = Number(val) || 0;
        break;
      case "TAUNT":
        ent.taunt = val === "1";
        break;
      case "DIVINE_SHIELD":
        ent.divineShield = val === "1";
        break;
      case "EXHAUSTED":
        ent.exhausted = val === "1";
        break;
    }
  }

  state(): HsMatchState {
    const all = [...this.entities.values()];
    const friendlyHero =
      all.find((e) => e.cardType === "HERO" && e.zone === "PLAY" && e.controller === this.friendlyPlayerId) ?? null;
    const enemyHero =
      all.find((e) => e.cardType === "HERO" && e.zone === "PLAY" && e.controller !== this.friendlyPlayerId) ?? null;
    const friendlyBoard = all.filter(
      (e) => e.cardType === "MINION" && e.zone === "PLAY" && e.controller === this.friendlyPlayerId,
    );
    const enemyBoard = all.filter(
      (e) => e.cardType === "MINION" && e.zone === "PLAY" && e.controller !== this.friendlyPlayerId,
    );
    const friendlyHand = all.filter((e) => e.zone === "HAND" && e.controller === this.friendlyPlayerId);
    const enemyHandCount = all.filter((e) => e.zone === "HAND" && e.controller !== this.friendlyPlayerId).length;
    const manaObj = this.playerMana.get(this.friendlyPlayerId) ?? { total: 0, used: 0 };

    return {
      inMatch: this.inMatch,
      turn: this.turn,
      friendlyPlayerId: this.friendlyPlayerId,
      currentPlayerId: this.currentPlayerId,
      isMyTurn: this.inMatch && this.currentPlayerId === this.friendlyPlayerId,
      mana: Math.max(0, manaObj.total - manaObj.used),
      maxMana: manaObj.total,
      friendlyHero,
      enemyHero,
      friendlyBoard,
      enemyBoard,
      friendlyHand,
      enemyHandCount,
      ...(this.winner ? { winner: this.winner } : {}),
    };
  }
}

export function computeAdvice(state: HsMatchState): Record<string, unknown> {
  const readyAttackers = state.friendlyBoard.filter((m) => !m.exhausted && m.atk > 0);
  const taunts = state.enemyBoard.filter((m) => m.taunt);
  const totalBoardAttack = readyAttackers.reduce((s, m) => s + m.atk, 0);
  const tauntHp = taunts.reduce((s, m) => s + Math.max(1, m.health - m.damage), 0);
  const enemyEffectiveHp = state.enemyHero
    ? Math.max(0, state.enemyHero.health - state.enemyHero.damage + state.enemyHero.armor)
    : 0;
  const boardLethal = state.inMatch && state.enemyHero !== null && totalBoardAttack - tauntHp >= enemyEffectiveHp;
  const enemyNextTurnThreat = state.enemyBoard.reduce((s, m) => s + m.atk, 0);

  return {
    isMyTurn: state.isMyTurn,
    mana: state.mana,
    affordableHand: state.friendlyHand.filter((c) => c.cost <= state.mana),
    boardLethal,
    totalBoardAttack,
    tauntHp,
    enemyEffectiveHp,
    enemyNextTurnThreat,
  };
}
