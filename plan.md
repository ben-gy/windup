# Game Plan: Windup

## Overview
- **Name:** Windup
- **Repo name:** windup
- **Tagline:** Program three moves, wind it up, and watch it all go wrong.
- **Genre (directory category):** strategy

## Core Loop
Every round you're dealt a hand of movement cards (forward 1/2/3, back up, turn left/right,
u-turn). You slot three of them into your bot's program, in order. Then everyone's program
executes **simultaneously, one step at a time** — step 1 for all bots, then step 2, then step 3.

The tension is entirely prediction. You aren't racing a clock, you're guessing where the other
bot will be in two steps' time, because bots **push** each other. The cog you lined up perfectly
is gone because your rival shoved you one tile east on step 2 and you sailed straight past it into
a pit.

Cogs **ripen**: a cog nobody collects gains +1 value every round, up to 5. So the board's stakes
start tiny and end enormous, and the fat cog sitting in the middle of the arena on round 10 is
what everyone converges on at once. Most cog value when the rounds run out wins.

- **Win:** highest cog value at the end of the round limit.
- **Lose:** get out-collected. Falling in a pit respawns you at your start and cancels the rest of
  your program that round — a tempo loss, never an elimination. Nobody is ever knocked out.

## Controls
- **Desktop:** click/drag cards into the three program slots, click a slot to clear it, Enter to
  lock in. Number keys 1–6 slot a card, Backspace clears the last.
- **Mobile:** tap a card to slot it, tap a slot to clear it, big Lock In button. No D-pad needed —
  this is a card/slot game, not a twitch game, so `patterns/input.ts` virtual controls don't apply.
  Tap targets ≥44px.

## Multiplayer
- **Mode:** live P2P (2–4 players), plus solo vs bots, plus async-seed share.
- **Topology:** host-authoritative **commit/resolve**. The sim is a pure deterministic function,
  so peers stay in sync from the shared seed without streaming snapshots.
  - Channels (all ≤12 bytes): `pg` (client → host: this peer's locked program),
    `res` (host → all: the round's committed programs for every seat, which every peer then
    resolves with the identical pure function), `snap` (host → all: full state, for a late joiner
    or a freshly promoted host to re-anchor).
  - **Room entry:** `createRoomEntry` — Create a room OR type a code. Invite link is a
    convenience only. `?room=` honoured once, cleared via `clearRoomInUrl()` on the way out.
  - **Late joiner:** admitted as a spectator for the current round, seated from the next round's
    frozen roster; host sends `snap` on join so they see the live board immediately.
  - **Peer leave:** the seat stays on the board and auto-submits a default program (the host fills
    it), so a dropped player never deadlocks the round. Roster marks them "left".
  - **Host leaves:** `net.ts` promotes the min-id survivor and fires `onHostChange`. Because
    resolution is deterministic and every peer already holds identical state, the promoted peer
    simply flips authoritative: it adopts its local state, resumes the host-only planning timer
    (`setInterval`, not rAF) and the auto-submit for missing seats, and re-broadcasts `snap`. The
    game keeps advancing and can still reach game-over. Wired via
    `createNet(..., { onHostChange: (_id, self) => session.setHost(self) })`.
- **No-deadlock:** each round has a visible **planning timer**. When it expires the host resolves
  with whatever is committed, auto-filling any missing program. A player who wanders off costs the
  room one timer, never the session.

## End of round → rematch (live P2P)
The Net is created **once** when the room is entered and stays up until the player returns to the
menu. Rounds are versioned inside it by `patterns/rematch.ts` (`createRounds`). **No `net.leave()`
between rounds, ever.**

- "Play again" = `rounds.vote()`. Same room, same mesh, new round number + new seed + frozen roster.
- **While waiting:** the results screen shows who has voted and who hasn't, plus the live
  `startsInMs` countdown from `rematch.ts` — never a silent "waiting…".
- **One player declines / closes the tab:** quorum + the grace countdown starts the match without
  them; `voters()` drops peers who left. No deadlock.
- **Host leaves on the results screen:** the promoted peer inherits no tally, so `rematch.ts`'s
  resync poll re-collects votes and the new host runs the rematch normally.
- **Persists across rounds:** a running **match tally** (matches won per player) — the reason to
  play a fourth round.
- **Back to lobby** from results does NOT leave the room.

## Juice Plan
- **The reveal is the product.** Programs execute on a ~420ms-per-step cadence with eased tweens,
  so you *watch* your plan meet reality. Each step: bots slide, then resolve.
- Screen shake on a push (small) and on a pit fall (large). Hit-stop ~90ms when two bots collide.
- Particles: brass sparks on a push, a cog burst on collection (value-scaled), a dust plume on a
  pit fall, a slow shimmer on a cog that has ripened to 4+.
- Sound (`patterns/sound.ts`): `select` on slotting a card, `blip` per execution step,
  `hit` on a push, `explosion` on a pit fall, `coin` on a cog (pitch rises with value),
  `powerup` on the centre cog, `win`/`lose` at match end. `sfx.unlock()` on first gesture.
- A ripening cog visibly grows and gains teeth; the centre cog gets a rotating glow.
- Score pops tween up from the collected cog.
- All of the above degrade under `prefers-reduced-motion`: no shake, no hit-stop, minimal
  particles, and the step cadence stays (it's information, not decoration).

## Style Direction
**Vibe:** clockwork/brass on slate — cozy-brutalist, tactile.
**Palette:** slate ground (#1b1f24), brass cogs (#d9a441), and four colour-blind-safe seat colours
from the Okabe–Ito set: blue #0072b2, vermillion #d55e00, teal #009e73, purple #cc79a7. Seats are
**also** distinguished by a shape glyph (▲ ● ■ ◆) on the bot, so colour is never the only channel.
**Theme:** dark.
**Reference feel:** the tactile clunk of a wind-up toy; the read-the-room tension of a
simultaneous-reveal board game.

## Technical Architecture
- **Stack:** Vanilla TypeScript + Vite.
- **Render:** **Canvas 2D** for the arena (tweened simultaneous execution + particles is
  continuous motion), **DOM** for the HUD, cards, menus and results (crisp text, ≥44px tap
  targets, accessible by default).
- **Engine modules copied from patterns/:** net, rematch, lobby, rng, sound, storage, identity,
  mobile (+ mobile.css). Not loop.ts — the sim is turn-resolved, not fixed-timestep; the replay is
  a tween driven by rAF for visuals with all round/timer logic on `setInterval`.
- **Persistence:** localStorage via storage.ts — name, mute, mode, seen-help, best solo score.

## Balance (principle #18 — build the sim FIRST)
`tests/balance.test.ts` runs a few hundred fixed-seed bot-vs-bot games before any tuning, and
asserts the *shape*: P(leader at round N wins) flat-and-near-chance early, spiking only late; every
seat within a few points of 100/players; bounded blowouts; every game terminates.

Fairness is structural, not tuned: the board is generated with **90° rotational symmetry** and the
four start tiles are the four rotations of one point, so every seat's opening is identical up to
rotation. Cogs spawn in **symmetric orbits** (a seeded point *and* its 3 rotations, all at once),
plus a contested **centre cog** on the rotation's fixed point. Turn-0 imbalance is therefore
impossible by construction — and a test asserts it over many seeds rather than trusting the claim.

The ripening curve is the "small early, big late" lever, and it's a pure function of
`round - bornRound` — zero new state, so P2P sync is untouched. Any constant the fairness depends
on gets pinned by its own assertion.

## Non-Goals
- No conveyor belts, lasers, or board hazards beyond walls + pits (scope).
- No card upgrades/deck-building across rounds.
- No public noticeboard listing this run — rooms are private-by-default and invite-only.
- No spectator chat.

## How To Play (player-facing copy)
Slot three cards into your bot's program, then lock it in. Everyone's program runs at the same
time, one step at a time — and bots shove each other, so where you *end up* is rarely where you
planned. Grab cogs to score. A cog nobody takes ripens, gaining +1 value every round up to 5, so
the board gets richer the longer it sits. Most cog value when the rounds run out wins. Falling in a
pit just sends you back to your start and cancels the rest of that round's program.
