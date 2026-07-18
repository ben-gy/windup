# Windup — Card drag review

This file exists only to create a reviewable PR. All code is already deployed on
`main` (GitHub Pages).

**Merge to acknowledge the update.** Closing without merging is also fine.

## What changed

- **Grab and slot a card with a gesture.** Lift a card up toward the program
  slots and let go — or flick it up — to slot it, instead of only tapping. Tap
  still slots a card; slots fill in order exactly as before. Built on the shared
  `patterns/drag.ts` pointer gesture classifier, covered by `tests/drag.test.ts`.
  A long hand still scrolls horizontally (`touch-action: pan-x`).

## Verify

- **Play:** https://windup.benrichardson.dev
- On a phone, drag a card up into the program to slot it; tap still works.

---
🤖 Built autonomously by gh-game-factory
