/**
 * main.ts — bootstrap and screen wiring. Owns no game logic.
 *
 * The shape that matters:
 *
 *  - ONE Net per room visit, created when the player enters a room and torn down
 *    only on the way back to the menu. Rounds are versioned INSIDE it by
 *    rematch.ts. There is no leave/rejoin anywhere in this file, and there must
 *    never be — see engine/net.ts for the two-shipped-games story behind that.
 *  - `?room=` is honoured exactly once and cleared on the way out, so a reload
 *    or a home-screen icon never drags you back into a room you left.
 *  - The lobby and the results screen are two views of the same rematch
 *    protocol, not two ways to start a game.
 */

import './styles/mobile.css';
import './styles/main.css';

import { createMatch, soloSeats, type Chan, type Match, type Seat } from './match';
import { createFx } from './fx';
import { createRenderer, projectPath, SEAT_COLOURS } from './render';
import { buildReplay, poseAt, type Replay } from './replay';
import { renderResults, shareText } from './results';
import { startCountdown, type Countdown } from './countdown';
import { FOOTER, HELP_HTML, ABOUT_HTML, renderHud, renderMenu, renderModal, renderTray } from './ui';
import { makeDraggable } from './engine/drag';

/** Lift a card up this far (px) to slot it. */
const CARD_LIFT = 48;
import type { Card, GameState, RoundResult } from './game';
import { DEFAULT_MODE, modeOf, type Mode } from './modes';
import { createNet, type Net } from './engine/net';
import { createRounds, type Rounds } from './engine/rematch';
import {
  clearRoomInUrl,
  createLobby,
  createRoomEntry,
  inviteLink,
  normalizeRoomCode,
  setRoomInUrl,
} from './engine/lobby';
import { createSfx } from './engine/sound';
import { createStore } from './engine/storage';
import { resolveName } from './engine/identity';
import { hardenViewport } from './engine/mobile';

const app = document.getElementById('app')!;
const store = createStore('windup');
const sfx = createSfx(store.get('muted', false));
const fx = createFx();

hardenViewport();

let playerName = resolveName(store, () => 'Player');
let mode: Mode = modeOf(store.get('mode', DEFAULT_MODE.id));
let botCount = Math.min(3, Math.max(1, store.get('bots', 1)));

let net: Net | null = null;
let rounds: Rounds | null = null;
let match: Match | null = null;
let roomCode = '';
/** Wins per seat, kept across rematches inside one room. */
let tally: number[] = [];
let unloadHooked = false;

// A deep link is consumed ONCE. After that, "Play with friends" always offers
// create-or-join — never a silent teleport back into a stale room.
const url = new URL(location.href);
let deepLinkRoom = url.searchParams.get('room');
const seedParam = url.searchParams.get('seed');

/** First user gesture unlocks audio; browsers block it until then. */
function unlockAudioOnce(): void {
  const go = (): void => {
    try {
      sfx.unlock();
    } catch {
      /* audio is a nicety, never a blocker */
    }
    window.removeEventListener('pointerdown', go);
    window.removeEventListener('keydown', go);
  };
  window.addEventListener('pointerdown', go, { once: true });
  window.addEventListener('keydown', go, { once: true });
}
unlockAudioOnce();

function play(name: Parameters<typeof sfx.play>[0]): void {
  try {
    sfx.play(name);
  } catch {
    /* ignore */
  }
}

// ── menu ────────────────────────────────────────────────────────────────────

function showMenu(): void {
  teardownRoom();
  clearRoomInUrl();
  app.innerHTML =
    renderMenu({ name: playerName, mode, muted: sfx.muted(), best: store.get('best', 0), bots: botCount }) +
    renderModal('help', HELP_HTML) +
    renderModal('about', ABOUT_HTML);

  const nameInput = app.querySelector<HTMLInputElement>('.menu-name')!;
  nameInput.addEventListener('change', () => {
    playerName = nameInput.value.trim().slice(0, 16) || 'Player';
    store.set('name', playerName);
  });

  app.querySelectorAll<HTMLButtonElement>('.mode-opt').forEach((b) =>
    b.addEventListener('click', () => {
      mode = modeOf(b.dataset.mode);
      store.set('mode', mode.id);
      play('select');
      showMenu();
    }),
  );

  app.querySelectorAll<HTMLButtonElement>('.bot-opt').forEach((b) =>
    b.addEventListener('click', () => {
      botCount = Number(b.dataset.bots) || 1;
      store.set('bots', botCount);
      play('select');
      showMenu();
    }),
  );

  app.querySelector('.menu-solo')?.addEventListener('click', () => {
    playerName = nameInput.value.trim().slice(0, 16) || 'Player';
    store.set('name', playerName);
    startSolo();
  });
  app.querySelector('.menu-friends')?.addEventListener('click', () => {
    playerName = nameInput.value.trim().slice(0, 16) || 'Player';
    store.set('name', playerName);
    showRoomEntry();
  });

  app.querySelector('.menu-help')?.addEventListener('click', () => openModal('help'));
  app.querySelector('.menu-about')?.addEventListener('click', () => openModal('about'));
  app.querySelector('.menu-mute')?.addEventListener('click', () => {
    sfx.setMuted(!sfx.muted());
    store.set('muted', sfx.muted());
    play('blip');
    showMenu();
  });

  wireModals();

  // First visit: show the rules unprompted. Nobody reads a How-to-Play button.
  if (!store.get('seen', false)) {
    store.set('seen', true);
    openModal('help');
  }
}

function openModal(id: string): void {
  const m = document.getElementById(id);
  if (m) m.hidden = false;
}

function wireModals(): void {
  app.querySelectorAll<HTMLElement>('.modal').forEach((m) => {
    m.querySelector('.modal-close')?.addEventListener('click', () => {
      m.hidden = true;
      play('blip');
    });
    m.addEventListener('click', (e) => {
      if (e.target === m) m.hidden = true;
    });
  });
}

// ── solo ────────────────────────────────────────────────────────────────────

function startSolo(seed = (Math.random() * 0xffffffff) >>> 0): void {
  const seats = soloSeats(playerName, botCount);
  tally = seats.map(() => 0);
  buildMatch({ seed, seats, selfSeat: 0, isHost: true, multiplayer: false });
}

// ── rooms ───────────────────────────────────────────────────────────────────

function showRoomEntry(): void {
  app.innerHTML = '<div class="main-content screen"></div>' + FOOTER;
  const host = app.querySelector<HTMLElement>('.screen')!;
  createRoomEntry({
    container: host,
    title: 'Play with friends',
    subtitle: 'Start a room and share the code, or type a friend’s code to join. 2–4 players.',
    onSubmit: (code, created) => enterRoom(code, created),
    onCancel: () => showMenu(),
  });
}

/**
 * Join the room ONCE and hold it until the player leaves for the menu.
 * `claimHost` is true only for the peer that minted the code — a typed code, a
 * link or a deep link joins as a guest, or two peers race to host one room.
 */
function enterRoom(code: string, created: boolean): void {
  roomCode = normalizeRoomCode(code);
  setRoomInUrl(roomCode);

  net = createNet(
    { appId: 'windup', roomId: roomCode, claimHost: created },
    {
      // Host transfer: the promoted peer takes over the authoritative clock.
      // Without this wiring the survivor's board simply freezes — the exact
      // defect that shipped in rhythm-relay.
      onHostChange: (_id, isSelfHost) => match?.setHost(isSelfHost),
      onPeerLeave: (id) => {
        match?.seatGone(id);
        paintHud();
      },
      onPeers: () => paintHud(),
    },
  );

  // One receiver per channel for the room's whole life, dispatching to whatever
  // match is current. Channels outlive rounds; matches do not.
  const chans: Chan[] = ['pg', 'res', 'snap'];
  const senders = new Map<Chan, (d: unknown, to?: string | string[]) => void>();
  for (const ch of chans) {
    senders.set(
      ch,
      net.channel(ch, (data, from) => match?.receive(ch, data, from)),
    );
  }
  transportSend = (ch, data, to) => senders.get(ch)?.(data, to);

  rounds = createRounds({
    net,
    playerName,
    minPlayers: 2,
    // The host's mode travels frozen inside the round start. A setting each peer
    // reads from its own UI is a setting two peers can disagree about — and a
    // mode that changes board size would have them playing different games.
    roundOpts: () => ({ mode: mode.id }),
    onRound: (info) => {
      const opts = (info.opts ?? {}) as { mode?: unknown };
      const roundMode = modeOf(opts.mode);
      const seats: Seat[] = info.players.map((p) => ({ id: p.id, name: p.name, bot: null }));
      const selfSeat = info.players.findIndex((p) => p.id === net!.selfId);
      if (tally.length !== seats.length) tally = seats.map(() => 0);
      buildMatch({
        seed: info.seed,
        seats,
        selfSeat,
        isHost: info.isHost,
        multiplayer: true,
        mode: roundMode,
      });
    },
    onChange: () => {
      if (screen === 'results') renderResultsScreen();
    },
  });

  if (!unloadHooked) {
    unloadHooked = true;
    window.addEventListener('pagehide', () => void net?.leave());
  }

  showLobby();
}

function showLobby(): void {
  screen = 'lobby';
  app.innerHTML = '<div class="main-content screen"></div>' + FOOTER;
  const host = app.querySelector<HTMLElement>('.screen')!;
  createLobby({
    container: host,
    net: net!,
    rounds: rounds!,
    roomCode,
    minPlayers: 2,
    maxPlayers: 4,
    onCancel: () => showMenu(),
  });
}

/** Leave the room — the ONLY place net.leave() is called. */
function teardownRoom(): void {
  countdown?.cancel();
  countdown = null;
  match?.destroy();
  match = null;
  rounds?.destroy();
  rounds = null;
  replay = null;
  const going = net;
  net = null;
  transportSend = null;
  tally = [];
  if (going) void going.leave();
}

// ── the game screen ─────────────────────────────────────────────────────────

type Screen = 'menu' | 'lobby' | 'game' | 'results';
let screen: Screen = 'menu';

let transportSend: ((ch: Chan, data: unknown, to?: string) => void) | null = null;
let renderer: ReturnType<typeof createRenderer> | null = null;
let displayState: GameState | null = null;
let replay: { r: Replay; res: RoundResult; step: number; t: number; fired: number } | null = null;
let countdown: Countdown | null = null;
let countValue: number | null = null;
let slots: (Card | null)[] = [];
let usedCards: number[] = [];
let multiplayer = false;
let rafId = 0;
let lastTs = 0;

const STEP_MS = 460;

function buildMatch(o: {
  seed: number;
  seats: Seat[];
  selfSeat: number;
  isHost: boolean;
  multiplayer: boolean;
  mode?: Mode;
}): void {
  match?.destroy();
  replay = null;
  multiplayer = o.multiplayer;
  const m = o.mode ?? mode;

  match = createMatch({
    seed: o.seed,
    mode: m,
    seats: o.seats,
    selfSeat: o.selfSeat,
    isHost: o.isHost,
    transport: o.multiplayer ? { send: (ch, d, to) => transportSend?.(ch, d, to) } : undefined,
    // Solo only, deliberately. In a room, one player switching tabs must never
    // stall the round for everyone else.
    pauseWhen: o.multiplayer ? undefined : () => document.hidden,
    onResolved: (res) => startReplay(res),
    onChange: () => {
      if (screen === 'game') paintHud();
    },
    onOver: () => {
      /* handled once the replay finishes, so the last round is watched */
    },
  });

  displayState = match.state();
  resetProgram();
  showGameScreen();

  // Count everyone in. Each peer counts locally from the host's start, which
  // keeps them within a network hop — and the round clock is host-authoritative
  // anyway, so the countdown is theatre rather than timing.
  countdown?.cancel();
  countValue = 3;
  countdown = startCountdown({
    onBeat: (n) => {
      countValue = n;
      play(n === 0 ? 'powerup' : 'blip');
    },
    onDone: () => {
      countValue = null;
      paintTray();
    },
  });
}

function showGameScreen(): void {
  screen = 'game';
  app.innerHTML = `
    <div class="main-content game">
      <div class="hud-host"></div>
      <div class="arena"><canvas class="board" aria-label="The arena"></canvas></div>
      <div class="tray-host"></div>
    </div>
    ${renderModal('pause', `<h2>Paused</h2><p>The round clock keeps running in multiplayer — your bot will be played for you if you time out.</p><div class="pause-actions"><button class="btn pause-menu" type="button">Quit to menu</button></div>`)}
    ${renderModal('help', HELP_HTML)}`;

  const canvas = app.querySelector<HTMLCanvasElement>('canvas.board')!;
  renderer = createRenderer(canvas);
  wireModals();
  app.querySelector('.pause-menu')?.addEventListener('click', () => showMenu());

  paintHud();
  paintTray();
  startLoop();
  window.addEventListener('resize', onResize);
}

function onResize(): void {
  if (displayState && renderer) renderer.resize(displayState.board);
}

function resetProgram(): void {
  const m = match!;
  slots = new Array(m.mode.slots).fill(null);
  usedCards = [];
}

function paintHud(): void {
  const m = match;
  if (!m || screen !== 'game') return;
  const host = app.querySelector<HTMLElement>('.hud-host');
  if (!host) return;
  const s = displayState ?? m.state();
  const live = m.seats.filter((x) => !x.bot && !x.gone).length;
  host.innerHTML = renderHud({
    round: Math.min(s.round, m.mode.rounds),
    rounds: m.mode.rounds,
    seats: m.seats,
    scores: s.bots.map((b) => b.score),
    selfSeat: m.selfSeat,
    planMs: replay || countValue !== null ? null : m.planMs(),
    committed: m.committed(),
    liveSeats: Math.max(1, live),
    modeName: m.mode.name,
    isHost: m.isHost(),
    multiplayer,
    hostSettled: !multiplayer || (net?.hostSettled() ?? false),
  });
  host.querySelector('.hud-menu')?.addEventListener('click', () => openModal('pause'));
}

function paintTray(): void {
  const m = match;
  if (!m || screen !== 'game') return;
  const host = app.querySelector<HTMLElement>('.tray-host');
  if (!host) return;

  // Mid-replay the tray shows the program that actually ran — read back off the
  // resolved timeline, so it is honest even when the clock played you.
  if (replay) {
    host.innerHTML = renderTray({
      hand: [],
      slots: m.selfSeat >= 0 ? replay.res.steps.map((s) => s.cards[m.selfSeat] ?? null) : [],
      used: [],
      locked: true,
      waiting: false,
      running: replay.step,
    });
    return;
  }

  const locked = m.locked() !== null || countValue !== null;
  host.innerHTML = renderTray({
    hand: m.hand(),
    slots,
    used: usedCards,
    locked,
    waiting: m.locked() !== null,
  });

  host.querySelectorAll<HTMLButtonElement>('.card').forEach((b) => {
    const idx = Number(b.dataset.card);
    // Tap still slots a card, but you can also LIFT it up into the program —
    // drag it up toward the slots (or flick up) and let go. Horizontal stays
    // with the browser (pan-x) so a long hand still scrolls.
    const reset = (): void => {
      b.classList.remove('is-dragging', 'will-play');
      b.style.transform = '';
    };
    makeDraggable(b, {
      onTap: () => slotCard(idx),
      onDragStart: () => b.classList.add('is-dragging'),
      onDragMove: (_dx, dy) => {
        b.style.transform = `translateY(${Math.min(0, dy)}px)`;
        b.classList.toggle('will-play', dy < -CARD_LIFT);
      },
      onDrop: (_dx, dy) => {
        reset();
        if (dy < -CARD_LIFT) slotCard(idx);
      },
      onSwipe: (dir) => {
        reset();
        if (dir === 'up') slotCard(idx);
      },
      onCancel: reset,
    });
  });
  host.querySelectorAll<HTMLButtonElement>('.slot').forEach((b) =>
    b.addEventListener('click', () => clearSlot(Number(b.dataset.slot))),
  );
  host.querySelector('.tray-clear')?.addEventListener('click', () => {
    resetProgram();
    play('blip');
    paintTray();
  });
  host.querySelector('.tray-lock')?.addEventListener('click', lockIn);
}

function slotCard(handIndex: number): void {
  const m = match;
  if (!m || m.locked() || replay || countValue !== null) return;
  if (usedCards.includes(handIndex)) return;
  const free = slots.findIndex((s) => s === null);
  if (free < 0) return;
  slots[free] = m.hand()[handIndex];
  usedCards[free] = handIndex;
  play('select');
  paintTray();
}

function clearSlot(i: number): void {
  const m = match;
  if (!m || m.locked() || replay) return;
  if (slots[i] === null) return;
  slots[i] = null;
  usedCards[i] = -1;
  // Compact so slot order always reads 1,2,3 with no holes in the middle.
  const cards = slots.filter((s) => s !== null) as Card[];
  const used = usedCards.filter((u) => u >= 0);
  slots = new Array(m.mode.slots).fill(null);
  usedCards = [];
  cards.forEach((c, k) => {
    slots[k] = c;
    usedCards[k] = used[k];
  });
  play('blip');
  paintTray();
}

function lockIn(): void {
  const m = match;
  if (!m || slots.some((s) => s === null)) return;
  m.submit(slots.slice());
  play('powerup');
  paintTray();
  paintHud();
}

/**
 * Send whatever the player has staged, just before the clock runs out.
 *
 * Found by playing it: you can fill all three slots, run out of time before
 * hitting Lock in, and have the round played by a bot instead — your actual
 * choices thrown away. The timeout exists so an ABSENT player cannot hold the
 * room, not to punish a present one for being slow on the last tap.
 *
 * The margin is generous enough for the program to reach the host before its
 * deadline; a partial program is sent as-is, and the empty slots simply stand
 * still, which is still closer to intent than a bot improvising.
 */
const AUTOSEND_MS = 1800;

function autoSendIfDue(): void {
  const m = match;
  if (!m || replay || countValue !== null) return;
  if (m.selfSeat < 0 || m.locked()) return;
  const left = m.planMs();
  if (left === null || left > AUTOSEND_MS) return;
  if (slots.every((s) => s === null)) return; // nothing chosen — let the bot play
  m.submit(slots.slice());
  paintTray();
  paintHud();
}

/**
 * Never leave a round half-revealed behind a hidden tab.
 *
 * The replay runs on rAF, which browsers pause when you switch away — so it
 * freezes mid-step and is still sitting there, stale, when you come back. In a
 * room that is worse than useless: the others have played on, and you would be
 * watching a round that finished a minute ago. So skip to the end state; the
 * reveal is entertainment, and you already missed it.
 */
document.addEventListener('visibilitychange', () => {
  if (document.hidden && replay) endReplay();
});

document.addEventListener('keydown', (e) => {
  if (screen !== 'game' || !match) return;
  if (e.key >= '1' && e.key <= '6') slotCard(Number(e.key) - 1);
  else if (e.key === 'Backspace') {
    const last = slots.map((s) => s !== null).lastIndexOf(true);
    if (last >= 0) clearSlot(last);
  } else if (e.key === 'Enter') lockIn();
});

// ── replay ──────────────────────────────────────────────────────────────────

/**
 * Wall-clock deadline for the running replay.
 *
 * The replay ANIMATES on rAF, which is right — it is a visual. But the game's
 * FLOW hangs off its completion (the next planning phase only opens when the
 * reveal ends), and flow must never depend on rAF: browsers pause it in a
 * backgrounded tab, so the round would sit half-revealed forever and the player
 * would be auto-played while a frozen board stared back at them.
 *
 * So the animation stays on rAF and a setInterval enforces the ending. Same rule
 * as the round clock: rAF for pixels, timers for time.
 */
let replayEndsAt = 0;

const flowTick = setInterval(() => {
  if (replay && Date.now() > replayEndsAt) endReplay();
}, 250);
window.addEventListener('pagehide', () => clearInterval(flowTick));

function startReplay(res: RoundResult): void {
  // Draw the board as it was when the round opened — the replay removes cogs as
  // they are actually taken.
  displayState = res.before;
  const poses = res.before.bots.map((b) => ({ x: b.x, y: b.y, f: b.f, alpha: 1 }));
  replay = { r: buildReplay(res, poses), res, step: 0, t: 0, fired: 0 };
  // Generous slack over the nominal length, so the timer only ever catches a
  // genuinely stalled replay rather than racing a slow-but-live one.
  replayEndsAt = Date.now() + res.steps.length * STEP_MS + 1500;
  paintTray();
  paintHud();
}

function fireTrigger(ev: RoundResult['steps'][0]['events'][0]): void {
  const s = displayState!;
  const r = renderer!;
  if (ev.t === 'cog') {
    const i = s.cogs.findIndex((c) => c.x === ev.x && c.y === ev.y);
    if (i >= 0) s.cogs.splice(i, 1);
    const bot = s.bots[ev.seat];
    bot.score += ev.value;
    bot.cogs++;
    bot.best = Math.max(bot.best, ev.value);
    const p = r.centreOfCell(ev.x, ev.y);
    fx.burst(p.x, p.y, ev.centre ? '#f0c56b' : '#d9a441', 10 + ev.value * 4, 70 + ev.value * 18);
    fx.pop(p.x, p.y, `+${ev.value}`, SEAT_COLOURS[ev.seat % 4]);
    if (ev.value >= 4) fx.shake(3);
    play(ev.centre ? 'powerup' : 'coin');
    paintHud();
  } else if (ev.t === 'push') {
    const b = s.bots[ev.seat];
    const p = r.centreOfCell(b.x, b.y);
    fx.burst(p.x, p.y, '#e8d9b0', 6, 60);
    fx.shake(2.5);
    fx.stop(70);
    play('hit');
  } else if (ev.t === 'fall') {
    const p = r.centreOfCell(ev.x, ev.y);
    fx.burst(p.x, p.y, '#5b6673', 16, 90);
    fx.shake(8);
    fx.stop(110);
    play('explosion');
    s.bots[ev.seat].falls++;
    paintHud();
  } else if (ev.t === 'bump') {
    play('blip');
  }
}

function endReplay(): void {
  const res = replay!.res;
  replay = null;
  displayState = res.state;
  // The spawn beat: new cogs land, and everything left ripens by one.
  for (const c of res.spawned) {
    const p = renderer!.centreOfCell(c.x, c.y);
    fx.burst(p.x, p.y, '#d9a441', 8, 50);
  }
  if (res.spawned.length) play('coin');

  if (res.state.over) {
    showResultsScreen();
    return;
  }
  resetProgram();
  paintTray();
  paintHud();
}

function startLoop(): void {
  cancelAnimationFrame(rafId);
  lastTs = 0;
  const frame = (ts: number): void => {
    rafId = requestAnimationFrame(frame);
    const dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0;
    lastTs = ts;
    fx.update(dt);
    if (!displayState || !renderer || screen !== 'game') return;
    autoSendIfDue();

    let step = null;
    let poses = null;
    if (replay) {
      // Hit-stop holds the replay, not the particles — the freeze is the point.
      if (fx.held() <= 0) replay.t += (dt * 1000) / STEP_MS;
      const cur = replay.r.steps[replay.step];
      if (cur) {
        for (const trig of cur.triggers) {
          if (trig.t <= replay.t && replay.fired < cur.triggers.indexOf(trig) + 1) {
            replay.fired = cur.triggers.indexOf(trig) + 1;
            fireTrigger(trig.ev);
          }
        }
        step = cur;
        poses = cur.tracks.map((tr) => poseAt(tr, Math.min(1, replay!.t)));
      }
      if (replay.t >= 1) {
        if (replay.step >= replay.r.steps.length - 1) endReplay();
        else {
          replay.step++;
          replay.t = 0;
          replay.fired = 0;
          paintTray(); // advance the highlighted step in the running program
        }
      }
    }

    renderer.draw(
      {
        state: displayState,
        poses,
        preview:
          !replay && countValue === null && match && match.selfSeat >= 0 && !match.locked()
            ? projectPath(displayState.board, displayState.bots[match.selfSeat], slots)
            : null,
        fx,
        selfSeat: match?.selfSeat ?? -1,
        countdown: countValue,
      },
      replay ? Math.min(1, replay.t) : 0,
      step,
      ts,
    );
  };
  rafId = requestAnimationFrame(frame);
}

// ── results ─────────────────────────────────────────────────────────────────

function showResultsScreen(): void {
  screen = 'results';
  cancelAnimationFrame(rafId);
  window.removeEventListener('resize', onResize);

  const s = displayState!;
  const winners = s.bots.filter((b) => b.score === Math.max(...s.bots.map((x) => x.score)));
  for (const w of winners) tally[w.seat] = (tally[w.seat] ?? 0) + 1;
  if (!multiplayer && match!.selfSeat >= 0) {
    const mine = s.bots[match!.selfSeat].score;
    if (mine > store.get('best', 0)) store.set('best', mine);
  }
  play(winners.some((w) => w.seat === match!.selfSeat) ? 'win' : 'lose');

  // A rematch reopens voting. It does NOT touch the room.
  rounds?.finish();
  renderResultsScreen();
}

function renderResultsScreen(): void {
  if (screen !== 'results' || !match || !displayState) return;
  const rs = rounds?.state();
  app.innerHTML =
    `<div class="main-content screen">` +
    renderResults({
      state: displayState,
      seats: match.seats,
      selfSeat: match.selfSeat,
      tally,
      multiplayer,
      voted: rs?.votes.map((v) => v.name),
      startsInMs: rs?.startsInMs ?? null,
      isHost: rs?.isHost,
      selfVoted: rs?.voted,
    }) +
    `</div>` +
    FOOTER;

  app.querySelector('.res-again')?.addEventListener('click', () => {
    if (multiplayer) {
      // Vote, and stay put. rematch.ts starts the round on quorum + a visible
      // countdown; the mesh is never touched.
      rounds?.vote();
      play('select');
      renderResultsScreen();
    } else {
      startSolo();
    }
  });
  app.querySelector('.res-force')?.addEventListener('click', () => rounds?.go());
  app.querySelector('.res-lobby')?.addEventListener('click', () => showLobby());
  app.querySelector('.res-menu')?.addEventListener('click', () => showMenu());
  app.querySelector('.res-share')?.addEventListener('click', () => void share());
}

async function share(): Promise<void> {
  const s = displayState!;
  // Solo shares the SEED so a friend can play the identical board and compare —
  // multiplayer shares the room.
  const link = multiplayer
    ? inviteLink(roomCode)
    : (() => {
        const u = new URL(location.href);
        u.searchParams.delete('room');
        u.searchParams.set('seed', String(s.seed));
        u.searchParams.set('mode', s.mode.id);
        return u.toString();
      })();
  const text = shareText(
    { state: s, seats: match!.seats, selfSeat: match!.selfSeat, tally, multiplayer },
    link,
  );
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Windup', text, url: link });
      return;
    }
    await navigator.clipboard.writeText(`${text}`);
    flashRes('Copied to clipboard');
  } catch {
    flashRes(link);
  }
}

function flashRes(msg: string): void {
  const el = app.querySelector<HTMLElement>('.res-flash');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1800);
}

// ── boot ────────────────────────────────────────────────────────────────────

function boot(): void {
  if (seedParam) {
    // An async-seed challenge link: same board, compare scores. Strip the params
    // so a reload does not relive someone else's game forever.
    const seed = Number(seedParam) >>> 0;
    mode = modeOf(url.searchParams.get('mode'));
    const clean = new URL(location.href);
    clean.searchParams.delete('seed');
    clean.searchParams.delete('mode');
    history.replaceState(null, '', clean.toString());
    startSolo(seed);
    return;
  }

  if (deepLinkRoom) {
    // Consume the invite once. Joining by link is never a host claim.
    const code = normalizeRoomCode(deepLinkRoom);
    deepLinkRoom = null;
    enterRoom(code, false);
    return;
  }

  showMenu();
}

boot();
