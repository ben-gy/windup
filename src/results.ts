// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * results.ts — the end-of-match summary.
 *
 * This screen is the one moment players compare themselves, so it shows
 * EVERYONE's round: what each player scored, how many cogs they took, the
 * fattest one they landed, and how often they fell in a pit. A summary that only
 * reflects you back at yourself wastes it.
 *
 * It also shows what everyone MISSED — the value still sitting on the board when
 * the whistle blew. In Windup that number is the argument you have afterwards:
 * "there was a 5 in the corner the whole time and neither of us went for it."
 *
 * Every player reaches this screen, including one whose round ended some other
 * way (host went silent, they joined late as a spectator). Never a frozen board.
 */

import { cogsOnBoard, cogValue, standings, type GameState } from './game';
import { SEAT_COLOURS, SEAT_GLYPHS } from './render';
import type { Seat } from './match';

export interface ResultsView {
  state: GameState;
  seats: Seat[];
  selfSeat: number;
  /** Matches won per seat across this room's session. */
  tally: number[];
  /** Live P2P adds rematch controls; solo just replays. */
  multiplayer: boolean;
  /** Who has voted to play again (names), for the waiting state. */
  voted?: string[];
  /** Ms until the next round starts without the stragglers. */
  startsInMs?: number | null;
  isHost?: boolean;
  selfVoted?: boolean;
}

export function renderResults(v: ResultsView): string {
  const table = standings(v.state);
  const left = cogsOnBoard(v.state);
  const fattest = v.state.cogs.reduce(
    (m, c) => Math.max(m, cogValue(c, v.state.round, v.state.mode.ripeCap)),
    0,
  );
  const won = table.filter((s) => s.winner);
  const selfWon = v.selfSeat >= 0 && won.some((s) => s.seat === v.selfSeat);

  const headline =
    v.selfSeat < 0
      ? `${name(v, won[0]?.seat ?? 0)} wins`
      : won.length > 1
        ? 'Dead heat'
        : selfWon
          ? 'You win!'
          : `${name(v, won[0]?.seat ?? 0)} wins`;

  const rows = table
    .map((s) => {
      const isSelf = s.seat === v.selfSeat;
      const seat = v.seats[s.seat];
      return `<tr class="res-row${isSelf ? ' is-self' : ''}${s.winner ? ' is-win' : ''}">
        <td class="res-who">
          <span class="res-chip" style="background:${SEAT_COLOURS[s.seat % 4]}">${SEAT_GLYPHS[s.seat % 4]}</span>
          <span class="res-name">${esc(seat?.name ?? `Seat ${s.seat + 1}`)}${isSelf ? ' (you)' : ''}</span>
          ${seat?.bot ? '<span class="res-tag">bot</span>' : ''}
          ${seat?.gone ? '<span class="res-tag">left</span>' : ''}
        </td>
        <td class="res-num res-score">${s.score}</td>
        <td class="res-num">${s.cogs}</td>
        <td class="res-num">${s.best || '—'}</td>
        <td class="res-num">${s.falls}</td>
        <td class="res-num">${v.tally[s.seat] ?? 0}</td>
      </tr>`;
    })
    .join('');

  const waiting =
    v.multiplayer && v.voted
      ? `<p class="res-waiting">
           ${v.voted.length ? `${esc(v.voted.join(', '))} ready to go again` : 'Nobody has voted yet'}
           ${
             v.startsInMs != null
               ? `<span class="res-count">· starting in ${Math.ceil(v.startsInMs / 1000)}s</span>`
               : ''
           }
         </p>`
      : '';

  return `
    <div class="results">
      <h2 class="res-title ${selfWon ? 'win' : ''}">${esc(headline)}</h2>
      <table class="res-table">
        <thead>
          <tr>
            <th>Player</th><th class="res-num">Score</th><th class="res-num">Cogs</th>
            <th class="res-num">Best</th><th class="res-num">Falls</th><th class="res-num">Wins</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="res-missed">
        ${
          left > 0
            ? `<strong>${left}</strong> points left on the board${fattest >= 4 ? ` — including a ripe <strong>${fattest}</strong> nobody claimed` : ''}.`
            : 'Every last cog collected. Nothing left behind.'
        }
      </p>
      ${waiting}
      <div class="res-actions">
        ${
          v.multiplayer
            ? `<button class="btn primary res-again" type="button">${v.selfVoted ? 'Waiting for others…' : 'Play again'}</button>
               ${v.isHost && v.voted && v.voted.length >= 2 ? '<button class="btn res-force" type="button">Start now</button>' : ''}
               <button class="btn res-lobby" type="button">Back to lobby</button>`
            : '<button class="btn primary res-again" type="button">Play again</button>'
        }
        <button class="btn ghost res-share" type="button">Share</button>
        <button class="btn ghost res-menu" type="button">Menu</button>
      </div>
      <div class="res-flash" role="status" aria-live="polite"></div>
    </div>`;
}

function name(v: ResultsView, seat: number): string {
  return v.seats[seat]?.name ?? `Seat ${seat + 1}`;
}

/** Shareable one-liner. Solo shares a seed so a friend can play the same board. */
export function shareText(v: ResultsView, seedLink: string): string {
  const table = standings(v.state);
  const me = table.find((s) => s.seat === v.selfSeat);
  const lines = [
    `Windup · ${v.state.mode.name}`,
    me ? `I scored ${me.score} (${me.cogs} cogs, best ${me.best || 0})` : '',
    table.length > 1
      ? table
          .slice(0, 4)
          .map((s) => `${SEAT_GLYPHS[s.seat % 4]} ${v.seats[s.seat]?.name ?? '—'} ${s.score}`)
          .join('  ')
      : '',
    seedLink,
  ];
  return lines.filter(Boolean).join('\n');
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}
