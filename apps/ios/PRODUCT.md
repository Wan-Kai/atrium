# Product

<!-- impeccable:product-schema 1 -->

## Platform

ios

## Users

One developer (the owner) who runs pi coding agents through Atrium on their Mac. On the phone, away from the desk, they check what the agents are doing, answer agent questions, unblock errors, send the next instruction, glance at uncommitted changes, and start new sessions.

## Product Purpose

Atrium is a macOS desktop coding agent built on pi; the iPhone app is its remote: a window onto the Mac's projects, workspaces and sessions through the owner's own relay. Success is that a waiting agent never sits idle because the owner was away from the Mac.

## Positioning

The phone talks only to the owner's Mac, end-to-end encrypted (Noise) through a self-hosted relay that only forwards. Nothing runs or is stored in a third-party cloud. The phone shows the Mac's real state: running, waiting for an answer, failed, unread, uncommitted, merged.

## Operating Context

- Glances of seconds to a minute: in a queue, on a commute, on the sofa. One hand, often outdoors or at night.
- The home screen answers "does anything need me?" first, then "what is running where?".
- Structure on the Mac: project → workspace (a git worktree on a branch) → sessions; plus chats not bound to a project.

## Capabilities and Constraints

- Native SwiftUI, iOS 26 minimum, Liquid Glass available. Sideloaded with a free 7-day signature.
- Host states the phone must show: connected, syncing, reconnecting, host offline, relay unreachable, version mismatch. Session states: asking you, error, running, unread, idle.
- The host sends no user-facing text, only codes and parameters; all words are the app's.
- Shared with the desktop: the state shapes, the process rail structure, the pixel-cat brand illustration (`packages/ui/src/design/brand/atrium.svg`), the spring presets.

## Brand Commitments

- Name: Atrium. Mascot: a 32×32 dot-matrix pixel cat (cream body, ink-blue features `#1f2537`, slate-blue ground `#6c86cc`, pink cheeks `#f0aea6`).
- Brand gradient for rare "full power" moments: blue `#5e84ff` → cyan `#78d6d6` → peach `#ffaa78`, optional violet `#b48cff`.
- 2026-10-28 the owner asked for an Atrium brand color of its own on the phone instead of the generic blue tint (`#2f6fed`), with loading indicators in the same color. The current warm cream look is open to replacement, and the home screen structure may change.
- Official icons only: file types from material-icon-theme, providers from their own sites; never letters or hand-drawn substitutes.

## Evidence on Hand

- Current spec and finished prototype: `docs/architecture/design-language.md` "手机端", `prototypes/mobile-app-final-prototype.html`, SPEC-0005.
- No real screenshots of user data may be published; prototypes use synthetic projects and sessions.

## Product Principles

1. What needs the owner comes first; everything else waits below.
2. The Mac is the source of truth; the phone never pretends a state it has not synced.
3. Glanceable in one hand: large targets, short lines, at most three pieces of meta per row.
4. Calm when nothing is happening; the brand shows in precise details and the cat, not in noise.

## Accessibility & Inclusion

Dynamic Type, Reduce Motion (crossfades instead of springs) and Reduce Transparency (solid glass fallbacks) are required; light and dark both first-class.
