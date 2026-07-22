# Windup

**Program three moves, wind it up, and watch it all go wrong.**

🎮 Play: https://windup.benrichardson.dev

## What it is

Windup is a strategy game about committing to a plan and watching it survive contact with
everyone else's. Each round you're dealt a hand of movement cards — forward 1/2/3, back up, turn
left/right, u-turn — and you slot three of them into your bot's program, in order. Then every
bot's program executes **simultaneously**, one step at a time.

You aren't racing a clock. You're guessing where the other bot will be in two steps' time, because
bots **shove** each other. The cog you lined up perfectly is gone because your rival pushed you one
tile east on step 2 and you sailed straight past it into a pit. Falling in costs you the rest of
that round's program and sends you back to your start — a tempo loss, never an elimination. Nobody
is ever knocked out.

The twist that makes the board worth fighting over: cogs **ripen**. A cog nobody collects gains +1
value every round, up to 5. The stakes start tiny and end enormous, so the fat cog sitting in the
middle of the arena on round 10 is the thing everyone converges on at once. Most cog value when the
rounds run out wins.

Play it solo against bots in five seconds, or open a room and play 2–4 friends peer-to-peer.

## How to play

Slot three cards into your program, then lock in. The dashed line shows where your program takes
you — *if nobody touches you*. Grab cogs to score.

- **Desktop:** click a card, or press <kbd>1</kbd>–<kbd>6</kbd> to slot it, <kbd>Backspace</kbd> to
  undo, <kbd>Enter</kbd> to lock in.
- **Mobile:** tap a card to slot it, tap a slot to clear it, then Lock in.

**Three modes**, and they genuinely play differently:

| Mode | Board | Rounds | Slots | Feel |
|---|---|---|---|---|
| Skirmish | 9×9 | 8 | 3 | Close quarters — everyone is always in shoving range. |
| Clockwork | 11×11 | 12 | 3 | The classic. Room to plan a route, time for a cog to ripen to 5. |
| Gauntlet | 13×13 | 16 | 4 | **Four** program slots — materially harder to predict, and to survive. |

In a room, the **host's** mode is what everyone plays; it travels with the round so two players can
never end up on different boards.

## Multiplayer

Live **peer-to-peer** for 2–4 players. Create a room and share the code (or the link — but a friend
can always just *type* the code), and your browsers connect directly to each other. There is no
game server, and nothing about your match is stored anywhere. A free public signalling relay is
used once, to introduce the browsers; that's the only third party involved, and rooms are private
and invite-only.

Because the simulation is a pure deterministic function of the shared seed, the host only ever
broadcasts the *programs* — a few bytes — and every peer computes the identical next state itself.
That makes the room robust in the ways that actually matter:

- **The host can leave.** A survivor is promoted and keeps the match running to a proper finish.
- **A player can drop or time out.** Their seat plays on autopilot; the round never deadlocks.
- **Play again** starts a fresh round inside the same room — the connection is never torn down.

## Fairness

Windup is competitive, so the balance is measured rather than asserted. `tests/balance.test.ts`
plays hundreds of fixed-seed bot-vs-bot matches and asserts the *shape* of the outcome: the early
lead stays near a coin flip (2P: 51% at round 1, 57% at round 3) and only becomes decisive near the
end, every seat wins its share, and blowouts are bounded.

Turn-0 fairness is structural, not tuned. The board is generated with **90° rotational symmetry**
and the start tiles are the four rotations of one point, so every seat's opening is identical up to
rotation. Cogs spawn in symmetric **orbits** — a seeded cell *and* its three rotations, all at once
— plus a contested **centre cog** on the rotation's fixed point.

The sim earned its keep: it found a real ~5-point seat bias in 3-player games (rotation-only
symmetry has no map from corner 0 to corner 2), which is now fixed by dealing the corners from the
shared seed.

## Tech

- Vite 6 + vanilla TypeScript
- Canvas 2D arena (tweened simultaneous execution + particles), DOM for HUD, cards and menus
- Shared engine: Trystero P2P netcode, deterministic seeded RNG, procedural audio
- Vitest — 180+ tests covering the rules, P2P-sync determinism, host transfer, the rematch
  lifecycle, host election and game balance
- GitHub Pages hosting

No cookies, no fingerprinting, no third-party fonts. Anonymous, cookie-less page-view counts via
Cloudflare Web Analytics.

## Local dev

```bash
npm install
npm run dev
npm test
npm run build
npm run preview
```

## license

[GNU Affero General Public License v3.0 or later](./LICENSE), with an attribution
requirement added under section 7(b) — see
[ADDITIONAL-TERMS.md](./ADDITIONAL-TERMS.md).

In short: you may run, modify, redistribute and even sell this, but if you
distribute it — or run a modified version where other people can reach it — you
have to publish your source under the same licence and keep the attribution. A
separate commercial licence without those obligations is available on request:
<hi@ben.gy>.

Third-party components keep their own licences — see
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).
