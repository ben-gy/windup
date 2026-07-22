// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * ui.ts — every screen that is not the arena: menu, help, about, HUD, the card
 * tray. DOM rather than canvas, so text is crisp, tap targets are real and the
 * whole thing is keyboard- and screen-reader-navigable for free.
 */

import { CARD_GLYPH, CARD_LABEL, type Card } from './game';
import { MODE_LIST, type Mode } from './modes';
import { SEAT_COLOURS, SEAT_GLYPHS } from './render';
import { esc } from './results';
import type { Seat } from './match';

export const FOOTER = `
  <footer class="site-footer">
    Built by <a href="https://benrichardson.dev/" target="_blank" rel="noopener">benrichardson.dev</a>
    · <a href="https://hub.benrichardson.dev" target="_blank" rel="noopener">more games, tools &amp; sites</a>
  </footer>`;

export function renderMenu(opts: {
  name: string;
  mode: Mode;
  muted: boolean;
  best: number;
  bots: number;
}): string {
  return `
    <div class="main-content menu">
      <header class="menu-head">
        <h1 class="logo"><span class="logo-cog" aria-hidden="true">✳</span> Windup</h1>
        <p class="tagline">Program three moves, wind it up, and watch it all go wrong.</p>
      </header>

      <div class="menu-panel">
        <label class="field">
          <span class="field-label">Your name</span>
          <input class="menu-name" type="text" maxlength="16" value="${esc(opts.name)}"
            aria-label="Your name" autocomplete="off" spellcheck="false" />
        </label>

        <fieldset class="field">
          <legend class="field-label">Mode</legend>
          <div class="mode-picker" role="radiogroup" aria-label="Game mode">
            ${MODE_LIST.map(
              (m) => `<button class="mode-opt${m.id === opts.mode.id ? ' on' : ''}" type="button"
                        role="radio" aria-checked="${m.id === opts.mode.id}" data-mode="${m.id}">
                        <span class="mode-name">${esc(m.name)}</span>
                        <span class="mode-blurb">${esc(m.blurb)}</span>
                      </button>`,
            ).join('')}
          </div>
        </fieldset>

        <fieldset class="field">
          <legend class="field-label">Solo opponents</legend>
          <div class="bot-picker" role="radiogroup" aria-label="Number of bots">
            ${[1, 2, 3]
              .map(
                (n) => `<button class="bot-opt${n === opts.bots ? ' on' : ''}" type="button"
                          role="radio" aria-checked="${n === opts.bots}" data-bots="${n}">${n} bot${n > 1 ? 's' : ''}</button>`,
              )
              .join('')}
          </div>
        </fieldset>
      </div>

      <div class="menu-actions">
        <button class="btn primary big menu-solo" type="button">Play solo</button>
        <button class="btn big menu-friends" type="button">Play with friends</button>
      </div>

      <div class="menu-links">
        <button class="btn ghost menu-help" type="button">How to play</button>
        <button class="btn ghost menu-about" type="button">About</button>
        <button class="btn ghost menu-mute" type="button" aria-pressed="${opts.muted}">
          ${opts.muted ? '🔇 Sound off' : '🔊 Sound on'}
        </button>
      </div>
      ${opts.best > 0 ? `<p class="menu-best">Best solo score: <strong>${opts.best}</strong></p>` : ''}
    </div>
    ${FOOTER}`;
}

export const HELP_HTML = `
  <h2>How to play</h2>
  <ol class="help-steps">
    <li><strong>Program three moves.</strong> Tap cards to slot them in order, then Lock in.</li>
    <li><strong>Everyone runs at once</strong>, one step at a time — and bots <em>shove</em> each other,
        so where you end up is rarely where you planned.</li>
    <li><strong>Grab cogs to score.</strong> A cog nobody takes <strong>ripens</strong>: +1 value every
        round, up to 5. The board gets richer the longer it sits.</li>
    <li><strong>Most cog value when the rounds run out wins.</strong> Falling in a pit just sends you
        back to your start and cancels the rest of that round's program — you are never knocked out.</li>
  </ol>
  <p class="help-controls">
    <strong>Desktop:</strong> click a card, or press <kbd>1</kbd>–<kbd>6</kbd> to slot it,
    <kbd>Backspace</kbd> to undo, <kbd>Enter</kbd> to lock in.<br />
    <strong>Mobile:</strong> tap a card — or lift it up into the program — to slot it; tap a slot to clear it.
  </p>
  <p class="help-tip">The dashed line shows where your program takes you — <em>if nobody touches you</em>.</p>`;

export const ABOUT_HTML = `
  <h2>About Windup</h2>
  <p>A strategy game about committing to a plan and watching it survive contact with everyone
     else's. Original mechanics, procedural art and audio — no assets, no trackers, no cookies.</p>
  <p><strong>Multiplayer is peer-to-peer.</strong> Your browsers connect directly to each other;
     there is no game server and nothing about your match is stored anywhere. A free public
     signalling relay is used once, to introduce the browsers to each other — that is the only
     third party involved, and rooms are private and invite-only.</p>
  <p>Anonymous, cookie-less page counts come from Cloudflare Web Analytics. Nothing else is
     collected.</p>
  <p>Built by <a href="https://benrichardson.dev/" target="_blank" rel="noopener">benrichardson.dev</a>
     · <a href="https://hub.benrichardson.dev" target="_blank" rel="noopener">more games, tools &amp; sites</a></p>`;

/** A modal that is genuinely gone when hidden — see the [hidden] rule in the CSS. */
export function renderModal(id: string, body: string): string {
  return `
    <div class="modal" id="${id}" hidden>
      <div class="modal-card" role="dialog" aria-modal="true">
        ${body}
        <button class="btn primary modal-close" type="button">Got it</button>
      </div>
    </div>`;
}

export interface HudView {
  round: number;
  rounds: number;
  seats: Seat[];
  scores: number[];
  selfSeat: number;
  planMs: number | null;
  committed: number;
  liveSeats: number;
  modeName: string;
  isHost: boolean;
  multiplayer: boolean;
  hostSettled: boolean;
}

export function renderHud(v: HudView): string {
  const chips = v.seats
    .map((s, i) => {
      const cls = [
        'hud-chip',
        i === v.selfSeat ? 'is-self' : '',
        s.gone ? 'is-gone' : '',
      ]
        .filter(Boolean)
        .join(' ');
      return `<div class="${cls}" style="--seat:${SEAT_COLOURS[i % 4]}">
        <span class="hud-glyph">${SEAT_GLYPHS[i % 4]}</span>
        <span class="hud-name">${esc(s.name)}${s.gone ? ' (left)' : ''}</span>
        <span class="hud-score">${v.scores[i]}</span>
      </div>`;
    })
    .join('');

  const clock =
    v.planMs === null
      ? ''
      : `<span class="hud-clock${v.planMs < 8000 ? ' urgent' : ''}">${Math.ceil(v.planMs / 1000)}s</span>`;

  return `
    <div class="hud">
      <div class="hud-top">
        <span class="hud-round">Round <strong>${v.round}</strong>/${v.rounds}</span>
        <span class="hud-mode">${esc(v.modeName)}</span>
        ${clock}
        <button class="btn tiny hud-menu" type="button" aria-label="Pause and menu">☰</button>
      </div>
      <div class="hud-seats">${chips}</div>
      ${
        v.multiplayer
          ? `<div class="hud-net">${
              !v.hostSettled
                ? '<span class="spinner sm"></span> connecting…'
                : `${v.committed}/${v.liveSeats} locked in${v.isHost ? ' · you host' : ''}`
            }</div>`
          : ''
      }
    </div>`;
}

export interface TrayView {
  hand: Card[];
  /** Slot contents; null = empty. */
  slots: (Card | null)[];
  /** Index in `hand` used by each slot, so a card can't be played twice. */
  used: number[];
  locked: boolean;
  waiting: boolean;
  /**
   * During a replay: the step currently executing. The tray then shows the
   * program that ACTUALLY RAN, step by step, instead of the next round's hand —
   * you watch your plan tick through while the bots move. Showing the new hand
   * mid-replay was just confusing: a locked program next to cards it never used.
   */
  running?: number | null;
}

export function renderTray(v: TrayView): string {
  const isRunning = v.running != null;
  const slots = v.slots
    .map(
      (c, i) => `<button class="slot${c ? ' filled' : ''}${isRunning && i === v.running ? ' active' : ''}"
          type="button" data-slot="${i}"
          aria-label="${c ? `Slot ${i + 1}: ${CARD_LABEL[c]}${isRunning ? '' : '. Tap to clear.'}` : `Slot ${i + 1}: empty`}"
          ${v.locked ? 'disabled' : ''}>
          <span class="slot-n">${i + 1}</span>
          <span class="slot-card">${c ? CARD_GLYPH[c] : ''}</span>
        </button>`,
    )
    .join('');

  if (isRunning) {
    return `
      <div class="tray">
        <div class="tray-slots" role="group" aria-label="The program running now">${slots}</div>
        <p class="tray-running" role="status">Winding up…</p>
      </div>`;
  }

  const cards = v.hand
    .map((c, i) => {
      const spent = v.used.includes(i);
      return `<button class="card${spent ? ' spent' : ''}" type="button" data-card="${i}"
          aria-label="${CARD_LABEL[c]}" ${v.locked || spent ? 'disabled' : ''}>
          <span class="card-glyph">${CARD_GLYPH[c]}</span>
          <span class="card-label">${esc(CARD_LABEL[c])}</span>
        </button>`;
    })
    .join('');

  const full = v.slots.every((s) => s !== null);
  return `
    <div class="tray">
      <div class="tray-slots" role="group" aria-label="Your program">${slots}</div>
      <div class="tray-cards" role="group" aria-label="Your hand">${cards}</div>
      <div class="tray-actions">
        ${
          v.locked
            ? `<p class="tray-wait"><span class="spinner sm" aria-hidden="true"></span>
                 ${v.waiting ? 'Waiting for the others…' : 'Locked in'}</p>`
            : `<button class="btn ghost tray-clear" type="button">Clear</button>
               <button class="btn primary tray-lock" type="button" ${full ? '' : 'disabled'}>
                 ${full ? 'Lock in' : `Pick ${v.slots.filter((s) => !s).length} more`}
               </button>`
        }
      </div>
    </div>`;
}
