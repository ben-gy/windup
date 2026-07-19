/**
 * match.ts — the round protocol: collect programs, resolve, repeat.
 *
 * This sits between the pure sim (game.ts) and the network (net.ts), and it is
 * the same object in solo and in multiplayer — solo is simply a match where
 * every other seat is a bot and the transport goes nowhere. One code path, so
 * the mode nobody tests cannot rot.
 *
 * WHY IT LOOKS LIKE THIS: because `resolveRound` is pure and deterministic, the
 * host never has to broadcast truth. It broadcasts the PROGRAMS — a few bytes —
 * and every peer computes the identical next state for itself. There is no
 * snapshot stream and nothing to reconcile.
 *
 * Host transfer therefore costs almost nothing, which is the whole point: every
 * peer already holds authoritative state, so a promoted peer just starts running
 * the clock (`setHost(true)`). That method is public and takes no network, which
 * is what lets tests/takeover.test.ts prove the gate without a relay.
 */

import { botName, chooseProgram, type Skill } from './bot';
import {
  createGame,
  dealHand,
  resolveRound,
  type Card,
  type Cog,
  type GameState,
  type RoundResult,
} from './game';
import { makeRng } from '@ben-gy/game-engine/rng';
import { modeOf, type Mode } from './modes';

export interface Seat {
  /** Peer id, or `bot:N` for an AI. */
  id: string;
  name: string;
  /** Non-null for an AI seat. */
  bot: Skill | null;
  /** A human who left the room. Their seat plays on, on autopilot. */
  gone?: boolean;
}

/** Channel names, all well inside Trystero's 12-byte limit. */
export type Chan = 'pg' | 'res' | 'snap';

export interface Transport {
  send(chan: Chan, data: unknown, to?: string): void;
}

export interface ProgramMsg {
  round: number;
  seat: number;
  program: (Card | null)[];
}

export interface ResultMsg {
  round: number;
  /** Program per seat, in frozen-roster order. */
  programs: (Card | null)[][];
}

export interface SnapMsg {
  seed: number;
  modeId: string;
  round: number;
  bots: { x: number; y: number; f: number; score: number; cogs: number; best: number; falls: number }[];
  cogs: Cog[];
  seats: number;
}

export interface MatchOpts {
  seed: number;
  mode: Mode;
  seats: Seat[];
  /** This peer's seat, or -1 for a spectator. */
  selfSeat: number;
  isHost: boolean;
  transport?: Transport;
  /** Fires with the timeline to replay. */
  onResolved?: (r: RoundResult) => void;
  /** Repaint the HUD (a program arrived, the clock ticked, a seat dropped). */
  onChange?: () => void;
  onOver?: (state: GameState) => void;
  /**
   * Freeze the round clock while this returns true — SOLO ONLY.
   *
   * The clock is a setInterval, so it keeps running in a backgrounded tab while
   * rAF (and therefore the replay) is paused. In solo that means glancing at
   * another tab burns the whole match: every 35s the host auto-plays you, and
   * you come back to a finished game you never saw.
   *
   * It must NOT be wired up in multiplayer. There, "pause" is unilateral — one
   * player switching tabs would stall the round for everyone, and a host that
   * paused itself would strand the room. An absent peer being auto-played is the
   * correct behaviour, and is exactly what the timeout is for.
   */
  pauseWhen?: () => boolean;
  /** Injectable for tests. */
  now?: () => number;
}

export interface Match {
  state(): GameState;
  mode: Mode;
  seats: Seat[];
  selfSeat: number;
  /** This seat's cards for the current round. */
  hand(): Card[];
  /** The program this peer has locked in, or null. */
  locked(): (Card | null)[] | null;
  /** Lock in a program for this round. */
  submit(program: (Card | null)[]): void;
  /** How many seats have committed. */
  committed(): number;
  /** Ms until the host resolves without you, or null if not counting. */
  planMs(): number | null;
  isHost(): boolean;
  /**
   * Promote/demote this peer. The gate from the multiplayer contract: a client
   * that becomes host must keep the match advancing and still be able to finish.
   */
  setHost(isHost: boolean): void;
  /** A peer left: its seat stays on the board and plays itself. */
  seatGone(peerId: string): void;
  /** Wire a received message in. */
  receive(chan: Chan, data: unknown, from: string): void;
  destroy(): void;
}

const RESEND_MS = 1000;
const TICK_MS = 250;

export function createMatch(opts: MatchOpts): Match {
  const now = opts.now ?? (() => Date.now());
  let state = createGame(opts.seed, opts.mode, opts.seats.length);
  let isHost = opts.isHost;
  let selfProgram: (Card | null)[] | null = null;
  /** seat -> program, for the round currently being planned. */
  let inbox = new Map<number, (Card | null)[]>();
  let deadline = now() + opts.mode.planSecs * 1000;
  let lastSend = 0;
  let lastTick = now();
  let destroyed = false;

  const send = (chan: Chan, data: unknown, to?: string): void => opts.transport?.send(chan, data, to);
  const change = (): void => opts.onChange?.();

  const hand = (): Card[] =>
    opts.selfSeat < 0 ? [] : dealHand(state.seed, state.round, opts.selfSeat, state.mode);

  /** Fill in every seat that has not committed, so a round can always resolve. */
  function completePrograms(): (Card | null)[][] {
    const rng = makeRng(state.seed + state.round * 7717);
    return opts.seats.map((seat, i) => {
      const given = inbox.get(i);
      if (given) return given;
      // Bots choose properly. A human who is absent, disconnected or simply out
      // of time is played by an easy bot rather than left standing still —
      // standing still reads as the game being broken, and a stalled seat must
      // never be able to hold the round.
      const skill: Skill = seat.bot ?? 'easy';
      return chooseProgram(state, i, dealHand(state.seed, state.round, i, state.mode), state.bots[i].home, {
        skill,
        rng,
      });
    });
  }

  function applyResult(msg: ResultMsg): void {
    // Monotonic guard: a duplicate or late-delivered result must not re-run a
    // round or rewind the board.
    if (msg.round !== state.round || state.over) return;
    const res = resolveRound(state, msg.programs);
    state = res.state;
    inbox = new Map();
    selfProgram = null;
    deadline = now() + state.mode.planSecs * 1000;
    opts.onResolved?.(res);
    change();
    if (state.over) opts.onOver?.(state);
  }

  function hostResolve(): void {
    if (!isHost || state.over) return;
    const msg: ResultMsg = { round: state.round, programs: completePrograms() };
    send('res', msg); // tell everyone…
    applyResult(msg); // …and apply the identical payload locally
  }

  function snapshot(): SnapMsg {
    return {
      seed: state.seed,
      modeId: state.mode.id,
      round: state.round,
      bots: state.bots.map((b) => ({
        x: b.x,
        y: b.y,
        f: b.f,
        score: b.score,
        cogs: b.cogs,
        best: b.best,
        falls: b.falls,
      })),
      cogs: state.cogs.map((c) => ({ ...c })),
      seats: opts.seats.length,
    };
  }

  function adoptSnapshot(msg: SnapMsg): void {
    // Only ever move forward. A snapshot from behind is a straggler's echo.
    if (msg.round <= state.round && !state.over) return;
    const fresh = createGame(msg.seed, modeOf(msg.modeId), msg.seats);
    fresh.round = msg.round;
    fresh.cogs = msg.cogs.map((c) => ({ ...c }));
    msg.bots.forEach((b, i) => {
      if (!fresh.bots[i]) return;
      Object.assign(fresh.bots[i], { x: b.x, y: b.y, f: b.f as 0, score: b.score, cogs: b.cogs, best: b.best, falls: b.falls });
    });
    fresh.over = msg.round > fresh.mode.rounds;
    state = fresh;
    inbox = new Map();
    selfProgram = null;
    deadline = now() + state.mode.planSecs * 1000;
    change();
  }

  const tick = setInterval(() => {
    if (destroyed || state.over) return;
    const t = now();

    // Solo, tab hidden: carry the deadline along with real time so the clock
    // effectively stands still rather than playing the match without you.
    if (opts.pauseWhen?.()) {
      deadline += t - lastTick;
      lastTick = t;
      return;
    }
    lastTick = t;

    // A client re-offers its program until the round moves on. This is what
    // makes host transfer self-healing: programs sent to a host that has since
    // vanished simply arrive at the new one on the next resend, with no
    // handshake and nothing to re-request.
    if (!isHost && selfProgram && t - lastSend > RESEND_MS) {
      lastSend = t;
      send('pg', { round: state.round, seat: opts.selfSeat, program: selfProgram } as ProgramMsg);
    }

    if (!isHost) return;

    const humans = opts.seats.filter((s, i) => !s.bot && !s.gone && i !== opts.selfSeat).length;
    const waiting = humans - [...inbox.keys()].filter((i) => !opts.seats[i].bot && i !== opts.selfSeat).length;
    const mine = opts.selfSeat < 0 || inbox.has(opts.selfSeat);

    // Resolve as soon as every live human is in, or when the clock runs out.
    // The clock is the no-deadlock guarantee: one player wandering off costs the
    // room a single timer, never the session.
    if ((waiting <= 0 && mine) || t >= deadline) hostResolve();
    else change();
  }, TICK_MS);

  return {
    mode: opts.mode,
    seats: opts.seats,
    selfSeat: opts.selfSeat,
    state: () => state,
    hand,
    locked: () => selfProgram,
    committed: () => inbox.size,
    isHost: () => isHost,
    planMs: () => (state.over ? null : Math.max(0, deadline - now())),

    submit(program) {
      if (opts.selfSeat < 0 || selfProgram || state.over) return;
      selfProgram = program.slice();
      inbox.set(opts.selfSeat, selfProgram);
      if (!isHost) {
        lastSend = now();
        send('pg', { round: state.round, seat: opts.selfSeat, program: selfProgram } as ProgramMsg);
      }
      change();
    },

    setHost(next) {
      const promoted = next && !isHost;
      isHost = next;
      if (promoted) {
        // Adopt local state as canonical — it already IS canonical, because every
        // peer resolved the same programs with the same pure function. Re-anchor
        // everyone else, then give the room a moment to resend its programs
        // before the clock can force a resolve.
        send('snap', snapshot());
        deadline = Math.max(deadline, now() + 2000);
      }
      change();
    },

    seatGone(peerId) {
      const i = opts.seats.findIndex((s) => s.id === peerId);
      if (i < 0) return;
      opts.seats[i].gone = true;
      change();
    },

    receive(chan, data, from) {
      if (chan === 'pg') {
        const msg = data as ProgramMsg;
        // Only the host collects, and only for the live round. Trust the sender's
        // seat only if it matches the roster — a peer cannot play someone else.
        if (!isHost || msg.round !== state.round) return;
        if (opts.seats[msg.seat]?.id !== from) return;
        inbox.set(msg.seat, msg.program);
        change();
      } else if (chan === 'res') {
        applyResult(data as ResultMsg);
      } else if (chan === 'snap') {
        adoptSnapshot(data as SnapMsg);
      }
    },

    destroy() {
      destroyed = true;
      clearInterval(tick);
    },
  };
}

/** Seats for a solo game: the player plus `n` bots. */
export function soloSeats(playerName: string, n: number, skill: Skill = 'normal'): Seat[] {
  const seats: Seat[] = [{ id: 'self', name: playerName, bot: null }];
  for (let i = 0; i < n; i++) seats.push({ id: `bot:${i}`, name: botName(i), bot: skill });
  return seats;
}
