/**
 * Batch 73: /start's own stylesheet, inlined into the page by start-page.tsx
 * (no extra request; nothing added to the site-wide CSS). A string module, so
 * the build and the tests read exactly the same rules.
 */
export const START_CSS = `
/*
 * Batch 73: /start only. Inlined into the page (no extra request, nothing added
 * to the site-wide stylesheet). Rule: every animation and every "hidden before
 * it plays" state lives inside @media (prefers-reduced-motion: no-preference),
 * so reduced motion — and the server's first paint — always show final states.
 * Motion is transform/opacity only (plus one SVG stroke draw); loops run only
 * while their block is on screen ([data-play="on"]).
 */
.s73 {
  --ink: #06120e;
  --ink-2: #0a1d16;
  --mint: #34d399;
  --mint-soft: rgba(52, 211, 153, 0.16);
  --spring: cubic-bezier(0.22, 1.18, 0.36, 1);
  --ease: cubic-bezier(0.22, 1, 0.36, 1);
}

/* ---------- dark surfaces ---------- */
.s73-dark {
  background: var(--ink);
  color: #fff;
  color-scheme: dark;
}
.s73-aurora {
  position: absolute;
  inset: -20% -10% auto -10%;
  height: 140%;
  pointer-events: none;
}
.s73-aurora i {
  position: absolute;
  border-radius: 9999px;
  will-change: transform;
}
.s73-aurora i:nth-child(1) {
  width: 70vmax;
  height: 70vmax;
  left: 35%;
  top: -25%;
  background: radial-gradient(closest-side, rgba(16, 185, 129, 0.34), rgba(16, 185, 129, 0) 70%);
}
.s73-aurora i:nth-child(2) {
  width: 60vmax;
  height: 60vmax;
  left: -25%;
  top: 10%;
  background: radial-gradient(closest-side, rgba(20, 184, 166, 0.22), rgba(20, 184, 166, 0) 70%);
}
.s73-aurora i:nth-child(3) {
  width: 45vmax;
  height: 45vmax;
  left: 60%;
  top: 40%;
  background: radial-gradient(closest-side, rgba(132, 204, 22, 0.14), rgba(132, 204, 22, 0) 70%);
}
.s73-grid {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.045) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.045) 1px, transparent 1px);
  background-size: 56px 56px;
  -webkit-mask-image: radial-gradient(ellipse 70% 60% at 50% 30%, #000 30%, transparent 75%);
  mask-image: radial-gradient(ellipse 70% 60% at 50% 30%, #000 30%, transparent 75%);
}

/* ---------- rotating word (no layout shift: all words share one grid cell) ---------- */
.s73-words {
  display: inline-grid;
  vertical-align: bottom;
}
.s73-words > span {
  grid-area: 1 / 1;
  white-space: nowrap;
  opacity: 0;
}
.s73-words > span[data-on="true"] {
  opacity: 1;
}

/* ---------- hero phone: tilt + glass chips ---------- */
.s73-stage {
  perspective: 1200px;
}
.s73-tilt {
  transform: rotateY(calc(-8deg + var(--ry, 0deg))) rotateX(calc(3deg + var(--rx, 0deg)));
  transform-style: preserve-3d;
}
.s73-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  white-space: nowrap;
  border-radius: 9999px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(14, 32, 25, 0.72);
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
  padding: 0.45rem 0.8rem;
  font-size: 0.78rem;
  font-weight: 600;
  color: #fff;
  box-shadow: 0 18px 40px -20px rgba(0, 0, 0, 0.7);
}
.s73-par {
  transform: translate3d(calc(var(--px, 0) * var(--d, 1) * 1px), calc(var(--py, 0) * var(--d, 1) * 1px), 0);
}

/* ---------- logo marquee ---------- */
.s73-marquee {
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent);
  mask-image: linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent);
  overflow: hidden;
}
.s73-track {
  display: flex;
  justify-content: center;
}
.s73-track > ul + ul {
  display: none;
}
/* Scene frames hidden at rest: the resting (final) frame is the answer / the confirmation. */
.s73-dots-cycle,
.s73-order {
  opacity: 0;
}

/* ---------- night story ---------- */
.s73-night {
  background: linear-gradient(180deg, #050d0b 0%, #071a22 55%, #0a1430 100%);
}
.s73-dawn {
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0;
  background:
    radial-gradient(70% 45% at 50% 100%, rgba(251, 191, 120, 0.35), transparent 70%),
    linear-gradient(180deg, #0a1a30 0%, #1f2a4d 40%, #5b3d5c 72%, #9a5a4c 100%);
}
.s73-dawn[data-on="true"] {
  opacity: 1;
}
.s73-step {
  opacity: 0.35;
}
@media (max-width: 1023px) {
  /* On a phone the steps pass under the pinned phone: keep only the current one readable. */
  .s73-step {
    opacity: 0.08;
  }
}
.s73-step[data-on="true"] {
  opacity: 1;
}
/* A story element that is not part of the current step (state, not motion). */
.s73-pop[data-on="false"] {
  opacity: 0;
}

/* ---------- leaks ---------- */
.s73-strike {
  position: relative;
  display: inline;
  background-image: linear-gradient(#dc2626, #dc2626);
  background-repeat: no-repeat;
  background-position: 0 58%;
  background-size: 100% 2px;
}

/* ---------- pricing card: a glow that runs around the border ---------- */
.s73-ring {
  position: relative;
  isolation: isolate;
  overflow: hidden;
  border-radius: 1.75rem;
  padding: 2px;
  box-shadow: 0 40px 90px -40px rgba(16, 185, 129, 0.55);
}
.s73-ring::before {
  content: "";
  position: absolute;
  inset: -60%;
  z-index: -1;
  background: conic-gradient(
    from 0deg,
    rgba(52, 211, 153, 0.15) 0 55%,
    rgba(52, 211, 153, 1) 72%,
    rgba(190, 242, 100, 0.9) 78%,
    rgba(52, 211, 153, 0.15) 92%
  );
}

/* ---------- FAQ: height animates through grid rows ---------- */
.s73-faq-a {
  display: grid;
  grid-template-rows: 0fr;
}
.s73-faq-a[data-open="true"] {
  grid-template-rows: 1fr;
}
.s73-faq-a > div {
  overflow: hidden;
}

/* ---------- timeline ---------- */
.s73-progress {
  transform-origin: 0 50%;
  transform: scaleX(var(--p, 1));
}
@media (max-width: 767px) {
  .s73-progress {
    transform-origin: 50% 0;
    transform: scaleY(var(--p, 1));
  }
}

/* ---------- sticky bar shimmer ---------- */
.s73-shimmer {
  position: relative;
  overflow: hidden;
}

/* ================= motion (only when the visitor allows it) ================= */
@media (prefers-reduced-motion: no-preference) {
  .s73-aurora i {
    animation: s73-drift 22s var(--ease) infinite alternate;
  }
  .s73-aurora i:nth-child(2) {
    animation-duration: 28s;
    animation-direction: alternate-reverse;
  }
  .s73-aurora i:nth-child(3) {
    animation-duration: 34s;
  }
  [data-play="off"] .s73-aurora i,
  [data-play="off"] .s73-anim,
  [data-play="off"] .s73-float,
  [data-play="off"] .s73-track {
    animation-play-state: paused;
  }

  .s73-words > span {
    transition:
      opacity 0.5s var(--ease),
      transform 0.5s var(--ease);
    transform: translateY(6px);
  }
  .s73-words > span[data-on="true"] {
    transform: none;
  }

  .s73-tilt {
    transition: transform 0.6s var(--spring);
  }
  .s73-float {
    animation: s73-float 6s ease-in-out infinite alternate;
  }
  .s73-par {
    transition: transform 0.7s var(--ease);
  }
  .s73-chip[data-on="false"] {
    opacity: 0;
    transform: translateY(8px) scale(0.9);
  }
  .s73-chip {
    transition:
      opacity 0.45s var(--ease),
      transform 0.55s var(--spring);
  }

  .s73-track {
    width: max-content;
    justify-content: flex-start;
    animation: s73-marquee 38s linear infinite;
  }
  .s73-track > ul {
    flex-wrap: nowrap;
  }
  .s73-track > ul + ul {
    display: flex;
  }
  .s73-marquee:hover .s73-track {
    animation-play-state: paused;
  }

  .s73-reveal {
    transition:
      opacity 0.7s var(--ease),
      transform 0.7s var(--spring);
  }
  .s73-reveal[data-shown="false"] {
    opacity: 0;
    transform: translateY(12px);
  }

  .s73-dawn {
    transition: opacity 0.9s var(--ease);
  }
  .s73-step {
    transition: opacity 0.4s var(--ease);
  }
  .s73-pop[data-on="false"] {
    transform: translateY(8px) scale(0.96);
  }
  .s73-pop {
    transition:
      opacity 0.4s var(--ease),
      transform 0.5s var(--spring);
  }
  .s73-clock > span {
    transition:
      opacity 0.35s var(--ease),
      transform 0.45s var(--spring);
  }
  .s73-clock > span[data-on="false"] {
    opacity: 0;
    transform: translateY(-6px);
  }

  .s73-leak[data-shown="false"] .s73-strike {
    background-size: 0% 2px;
  }
  .s73-strike {
    transition: background-size 0.6s var(--ease) 0.15s;
  }
  .s73-leak .s73-fix {
    transition:
      opacity 0.6s var(--ease) 0.55s,
      transform 0.6s var(--spring) 0.55s;
  }
  .s73-leak[data-shown="false"] .s73-fix {
    opacity: 0;
    transform: translateY(10px);
  }

  .s73-ring::before {
    animation: s73-spin 6s linear infinite;
  }

  .s73-faq-a {
    transition: grid-template-rows 0.35s var(--ease);
  }
  .s73-faq-icon {
    transition: transform 0.35s var(--spring);
  }

  .s73-shimmer[data-shimmer="on"]::after {
    content: "";
    position: absolute;
    inset: 0;
    background: linear-gradient(100deg, transparent 30%, rgba(255, 255, 255, 0.45) 50%, transparent 70%);
    transform: translateX(-120%);
    animation: s73-shimmer 6s var(--ease) 2s infinite;
    pointer-events: none;
  }

  /* bento + proof scenes */
  .s73-bar-fill {
    transform-origin: 0 50%;
    animation: s73-fill 5s var(--ease) infinite;
  }
  .s73-tick {
    animation: s73-rain 2.6s ease-in infinite;
  }
  .s73-tick:nth-child(2) {
    animation-delay: 0.5s;
  }
  .s73-tick:nth-child(3) {
    animation-delay: 1.1s;
  }
  .s73-tick:nth-child(4) {
    animation-delay: 1.6s;
  }
  .s73-tick:nth-child(5) {
    animation-delay: 2.1s;
  }
  .s73-dots-cycle {
    animation: s73-dots 4.4s var(--ease) infinite;
  }
  .s73-answer-cycle {
    animation: s73-answer 4.4s var(--ease) infinite;
  }
  .s73-draw {
    stroke-dasharray: 1;
    animation: s73-draw 4.8s var(--ease) infinite;
  }
  .s73-node {
    animation: s73-node 4.8s var(--spring) infinite;
  }
  .s73-node:nth-of-type(2) {
    animation-delay: 0.45s;
  }
  .s73-node:nth-of-type(3) {
    animation-delay: 0.9s;
  }
  .s73-node:nth-of-type(4) {
    animation-delay: 1.35s;
  }
  .s73-hop {
    animation: s73-hop 6s var(--spring) infinite;
  }
  .s73-assign {
    animation: s73-assign 6s var(--ease) infinite;
  }
  .s73-order {
    animation: s73-order 5.2s var(--ease) infinite;
  }
  .s73-confirm {
    animation: s73-confirm 5.2s var(--spring) infinite;
  }
  .s73-fly {
    animation: s73-fly 5.2s var(--ease) infinite;
  }
  .s73-type {
    animation: s73-type 6s steps(46, end) infinite;
  }
  .s73-draft {
    animation: s73-draft 6s var(--spring) infinite;
  }
  .s73-slide-in {
    animation: s73-slide-in 5s var(--ease) infinite;
  }
  .s73-staff {
    animation: s73-staff 5s var(--ease) infinite;
  }
}

@keyframes s73-drift {
  from {
    transform: translate3d(0, 0, 0) scale(1);
  }
  to {
    transform: translate3d(-6%, 4%, 0) scale(1.08);
  }
}
@keyframes s73-float {
  from {
    transform: translate3d(0, -4px, 0);
  }
  to {
    transform: translate3d(0, 5px, 0);
  }
}
@keyframes s73-marquee {
  to {
    transform: translate3d(-50%, 0, 0);
  }
}
@keyframes s73-spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes s73-shimmer {
  0% {
    transform: translateX(-120%);
  }
  18%,
  100% {
    transform: translateX(120%);
  }
}
@keyframes s73-fill {
  0% {
    transform: scaleX(0.02);
  }
  70%,
  92% {
    transform: scaleX(1);
  }
  100% {
    transform: scaleX(0.02);
  }
}
@keyframes s73-rain {
  0% {
    opacity: 0;
    transform: translateY(-14px);
  }
  20% {
    opacity: 1;
  }
  80% {
    opacity: 1;
  }
  100% {
    opacity: 0;
    transform: translateY(26px);
  }
}
@keyframes s73-dots {
  0%,
  42% {
    opacity: 1;
    transform: none;
  }
  48%,
  100% {
    opacity: 0;
    transform: scale(0.9);
  }
}
@keyframes s73-answer {
  0%,
  45% {
    opacity: 0;
    transform: translateY(8px) scale(0.96);
  }
  55%,
  92% {
    opacity: 1;
    transform: none;
  }
  100% {
    opacity: 0;
    transform: none;
  }
}
@keyframes s73-draw {
  0% {
    stroke-dashoffset: 1;
  }
  55%,
  88% {
    stroke-dashoffset: 0;
  }
  100% {
    stroke-dashoffset: 1;
  }
}
@keyframes s73-node {
  0% {
    opacity: 0.25;
    transform: scale(0.85);
  }
  12%,
  88% {
    opacity: 1;
    transform: none;
  }
  100% {
    opacity: 0.25;
    transform: scale(0.85);
  }
}
@keyframes s73-hop {
  0%,
  22% {
    transform: translateX(0);
  }
  33%,
  55% {
    transform: translateX(var(--hop, 72px));
  }
  66%,
  88% {
    transform: translateX(calc(var(--hop, 72px) * 2));
  }
  100% {
    transform: translateX(0);
  }
}
@keyframes s73-assign {
  0%,
  60% {
    opacity: 0;
    transform: translateY(6px) scale(0.9);
  }
  68%,
  90% {
    opacity: 1;
    transform: none;
  }
  100% {
    opacity: 0;
  }
}
@keyframes s73-order {
  0%,
  35% {
    opacity: 1;
    transform: none;
  }
  45%,
  100% {
    opacity: 0;
    transform: scale(0.94) translateY(-6px);
  }
}
@keyframes s73-confirm {
  0%,
  40% {
    opacity: 0;
    transform: translateY(10px) scale(0.95);
  }
  50%,
  92% {
    opacity: 1;
    transform: none;
  }
  100% {
    opacity: 0;
  }
}
@keyframes s73-fly {
  0%,
  50% {
    opacity: 0;
    transform: translate(-40px, 30px) rotate(-12deg) scale(0.8);
  }
  60% {
    opacity: 1;
  }
  75%,
  92% {
    opacity: 1;
    transform: none;
  }
  100% {
    opacity: 0;
  }
}
@keyframes s73-type {
  0% {
    clip-path: inset(0 100% 0 0);
  }
  45%,
  100% {
    clip-path: inset(0 0 0 0);
  }
}
@keyframes s73-draft {
  0%,
  50% {
    opacity: 0;
    transform: translateY(12px) scale(0.96);
  }
  60%,
  94% {
    opacity: 1;
    transform: none;
  }
  100% {
    opacity: 0;
  }
}
@keyframes s73-slide-in {
  0% {
    opacity: 0;
    transform: translateX(-36px) rotate(-6deg);
  }
  25%,
  85% {
    opacity: 1;
    transform: none;
  }
  100% {
    opacity: 0;
    transform: none;
  }
}
@keyframes s73-staff {
  0%,
  30% {
    opacity: 0.25;
  }
  40%,
  90% {
    opacity: 1;
  }
  100% {
    opacity: 0.25;
  }
}
`;
