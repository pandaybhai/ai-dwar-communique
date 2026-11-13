/**
 * Batch 80: the /999 page's own stylesheet, inlined by page-999.tsx (no extra
 * request; nothing added to the site-wide CSS).
 *
 * Rules: motion is transform / opacity only (plus SVG stroke draws); every
 * "hidden before it plays" state lives inside
 * @media (prefers-reduced-motion: no-preference), so reduced motion — and the
 * server's first paint — always show the finished state; loops run only while
 * their block is on screen ([data-play="on"]).
 */
export const P999_CSS = `
.p9 {
  --ink: #04100b;
  --ink-2: #0a1c15;
  --ink-3: #10291f;
  --mint: #3ee6a0;
  --mint-2: #10b981;
  /* text-safe green on the light surfaces (4.5:1+ on --paper and white) */
  --mint-ink: #047857;
  --mint-soft: rgba(62, 230, 160, 0.14);
  --paper: #f7f6f1;
  --line: rgba(4, 16, 11, 0.09);
  --wa-bg: #0b141a;
  --wa-in: #202c33;
  --wa-out: #005c4b;
  --spring: cubic-bezier(0.22, 1.2, 0.36, 1);
  --ease: cubic-bezier(0.22, 1, 0.36, 1);
  font-feature-settings: "ss01", "cv11";
}
.p9-dark { background: var(--ink); color: #fff; color-scheme: dark; }
.p9-paper { background: var(--paper); color: var(--ink); }

/* ---------- hero background: aurora + grain + grid ---------- */
.p9-aurora { position: absolute; inset: -30% -20% auto -20%; height: 150%; pointer-events: none; }
.p9-aurora i { position: absolute; border-radius: 9999px; will-change: transform; filter: blur(8px); }
.p9-aurora i:nth-child(1) {
  width: 80vmax; height: 80vmax; left: 30%; top: -35%;
  background: radial-gradient(closest-side, rgba(16, 185, 129, 0.42), rgba(16, 185, 129, 0) 70%);
}
.p9-aurora i:nth-child(2) {
  width: 64vmax; height: 64vmax; left: -30%; top: 5%;
  background: radial-gradient(closest-side, rgba(45, 212, 191, 0.26), rgba(45, 212, 191, 0) 70%);
}
.p9-aurora i:nth-child(3) {
  width: 46vmax; height: 46vmax; left: 55%; top: 45%;
  background: radial-gradient(closest-side, rgba(163, 230, 53, 0.16), rgba(163, 230, 53, 0) 70%);
}
.p9-grain {
  position: absolute; inset: 0; pointer-events: none; opacity: 0.18; mix-blend-mode: overlay;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='0.9'/></svg>");
}
.p9-grid {
  position: absolute; inset: 0; pointer-events: none;
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.05) 1px, transparent 1px);
  background-size: 48px 48px;
  -webkit-mask-image: radial-gradient(ellipse 70% 55% at 50% 25%, #000 25%, transparent 75%);
  mask-image: radial-gradient(ellipse 70% 55% at 50% 25%, #000 25%, transparent 75%);
}

/* ---------- headline ---------- */
.p9-h1 { letter-spacing: -0.045em; line-height: 0.98; }
.p9-word { display: inline-block; white-space: pre; }
.p9-shine {
  background: linear-gradient(100deg, #3ee6a0 0%, #a7f3d0 38%, #3ee6a0 55%, #22c55e 100%);
  background-size: 220% 100%;
  -webkit-background-clip: text; background-clip: text; color: transparent;
  /* room for the last glyph's overhang under the tight tracking */
  padding-right: 0.08em; margin-right: -0.08em;
}

/* ---------- buttons ---------- */
.p9-cta {
  position: relative; isolation: isolate;
  display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem;
  min-height: 3.5rem; padding: 0 1.75rem; border-radius: 9999px;
  background: var(--mint); color: #022c1b; font-weight: 800; font-size: 1.0625rem;
  letter-spacing: -0.01em;
  box-shadow: 0 0 0 1px rgba(255,255,255,0.25) inset, 0 18px 50px -12px rgba(62, 230, 160, 0.65);
  transition: transform 0.25s var(--spring), box-shadow 0.25s var(--ease), background-color 0.2s;
  -webkit-tap-highlight-color: transparent;
}
.p9-cta:hover { background: #5ff0b4; }
.p9-cta:active { transform: scale(0.97); }
.p9-cta:focus-visible { outline: 3px solid #fff; outline-offset: 3px; }
.p9-cta .p9-arrow { display: inline-block; transition: transform 0.25s var(--spring); }
.p9-cta:hover .p9-arrow { transform: translateX(4px); }
.p9-cta-glow { position: absolute; inset: -2px; border-radius: inherit; z-index: -1; pointer-events: none;
  background: radial-gradient(120px 60px at var(--mx, 50%) var(--my, 50%), rgba(255,255,255,0.55), transparent 70%);
  opacity: 0; transition: opacity 0.25s; }
.p9-cta:hover .p9-cta-glow { opacity: 1; }

/* ---------- phone ---------- */
.p9-stage { perspective: 1400px; }
.p9-phone {
  position: relative; border-radius: 2.6rem; padding: 0.55rem;
  background: linear-gradient(160deg, #24332c, #0c1712 55%, #1a2721);
  box-shadow:
    0 0 0 1px rgba(255,255,255,0.08) inset,
    0 60px 120px -40px rgba(0,0,0,0.85),
    0 30px 80px -30px rgba(16, 185, 129, 0.45);
  transform: rotateY(var(--ry, -9deg)) rotateX(var(--rx, 5deg));
  transform-style: preserve-3d;
  transition: transform 0.5s var(--ease);
}
.p9-screen { position: relative; overflow: hidden; border-radius: 2.1rem; background: var(--wa-bg); height: 468px; }
.p9-screen::before {
  content: ""; position: absolute; inset: 0; opacity: 0.06; pointer-events: none;
  background-image: radial-gradient(#fff 1px, transparent 1.2px); background-size: 18px 18px;
}
.p9-notch { position: absolute; top: 0.55rem; left: 50%; width: 34%; height: 1.15rem; transform: translateX(-50%);
  background: #000; border-radius: 0 0 0.9rem 0.9rem; z-index: 3; }
.p9-bubble { max-width: 82%; border-radius: 0.9rem; padding: 0.45rem 0.6rem 0.35rem; font-size: 13px; line-height: 1.38; }
.p9-in { background: var(--wa-in); color: #e9edef; border-top-left-radius: 0.25rem; }
.p9-out { background: var(--wa-out); color: #e9edef; border-top-right-radius: 0.25rem; margin-left: auto; }
.p9-meta { display: flex; justify-content: flex-end; align-items: center; gap: 3px; margin-top: 2px; font-size: 10.5px; color: rgba(233,237,239,0.6); }
.p9-tick { width: 16px; height: 11px; color: rgba(233,237,239,0.6); transition: color 0.35s; }
.p9-tick[data-read="true"] { color: #53bdeb; }
.p9-dots { display: inline-flex; gap: 4px; padding: 0.55rem 0.7rem; }
.p9-dots i { width: 6px; height: 6px; border-radius: 9999px; background: rgba(233,237,239,0.65); }
.p9-chip {
  flex: none; scroll-snap-align: start; position: relative; overflow: hidden;
  border-radius: 9999px; padding: 0.55rem 0.95rem; font-size: 13.5px; font-weight: 700;
  color: rgba(255,255,255,0.78); background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.12);
  transition: background-color 0.25s, color 0.25s, border-color 0.25s, transform 0.2s var(--spring);
}
.p9-chip:active { transform: scale(0.96); }
.p9-chip[aria-pressed="true"] { background: var(--mint); color: #022c1b; border-color: transparent; }
.p9-chip-fill { position: absolute; left: 0; bottom: 0; height: 3px; width: 100%; background: rgba(2,44,27,0.35);
  transform-origin: left; transform: scaleX(0); }
.p9-chips { scrollbar-width: none; scroll-snap-type: x mandatory; }
.p9-chips::-webkit-scrollbar { display: none; }

/* ---------- calculator ---------- */
.p9-range { -webkit-appearance: none; appearance: none; width: 100%; height: 44px; background: transparent; cursor: pointer; touch-action: pan-y; }
.p9-range:focus-visible { outline: none; }
.p9-range::-webkit-slider-runnable-track {
  height: 10px; border-radius: 9999px;
  background: linear-gradient(90deg, var(--mint-2) 0 var(--p, 50%), rgba(4,16,11,0.1) var(--p, 50%) 100%);
}
.p9-range::-moz-range-track { height: 10px; border-radius: 9999px; background: rgba(4,16,11,0.1); }
.p9-range::-moz-range-progress { height: 10px; border-radius: 9999px; background: var(--mint-2); }
.p9-range::-webkit-slider-thumb {
  -webkit-appearance: none; width: 30px; height: 30px; margin-top: -10px; border-radius: 9999px;
  background: #fff; border: 3px solid var(--mint-2); box-shadow: 0 6px 18px -4px rgba(16,185,129,0.6);
  transition: transform 0.2s var(--spring);
}
.p9-range:active::-webkit-slider-thumb { transform: scale(1.15); }
.p9-range:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 6px rgba(16,185,129,0.3); }
.p9-range::-moz-range-thumb { width: 26px; height: 26px; border-radius: 9999px; background: #fff; border: 3px solid var(--mint-2); }
.p9-bar { height: 12px; border-radius: 9999px; transform-origin: left; transition: transform 0.6s var(--ease); }
.p9-seg[aria-checked="true"] { background: var(--ink); color: #fff; box-shadow: 0 6px 16px -8px rgba(4,16,11,0.6); }

/* ---------- stamp ---------- */
.p9-stamp-ring { transform-origin: 50% 50%; }

/* ---------- steps (svg draw) ---------- */
.p9-draw { stroke-dasharray: 1; stroke-dashoffset: 0; }

/* ---------- sticky bar ---------- */
.p9-sticky { transition: transform 0.45s var(--spring), opacity 0.3s var(--ease); }
.p9-sticky[data-on="false"] { transform: translateY(130%); opacity: 0; pointer-events: none; }

/* ---------- faq ---------- */
.p9-faq summary { list-style: none; cursor: pointer; }
.p9-faq summary::-webkit-details-marker { display: none; }
.p9-faq .p9-plus { transition: transform 0.3s var(--spring); }
.p9-faq[open] .p9-plus { transform: rotate(45deg); }

/* ---------- confetti / success ---------- */
.p9-confetti { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.p9-confetti i { position: absolute; top: -12px; width: 8px; height: 14px; border-radius: 2px; opacity: 0; }

@media (prefers-reduced-motion: no-preference) {
  .p9-aurora i:nth-child(1) { animation: p9-drift 18s ease-in-out infinite alternate; }
  .p9-aurora i:nth-child(2) { animation: p9-drift 22s ease-in-out -6s infinite alternate-reverse; }
  .p9-aurora i:nth-child(3) { animation: p9-drift 26s ease-in-out -3s infinite alternate; }
  [data-play="off"] .p9-aurora i { animation-play-state: paused; }
  @keyframes p9-drift {
    from { transform: translate3d(-4%, 0, 0) scale(1); }
    to { transform: translate3d(5%, 6%, 0) scale(1.08); }
  }

  .p9-word { animation: p9-word-in 0.62s var(--ease) both; animation-delay: calc(var(--i, 0) * 55ms); }
  @keyframes p9-word-in {
    from { opacity: 0.001; transform: translate3d(0, 0.42em, 0) rotate(2deg); filter: blur(6px); }
    to { opacity: 1; transform: none; filter: none; }
  }
  .p9-shine { animation: p9-shine 6s ease-in-out 1.2s infinite; }
  @keyframes p9-shine { 0%, 100% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } }
  .p9-fade { animation: p9-fade 0.7s var(--ease) both; animation-delay: var(--d, 0.35s); }
  @keyframes p9-fade { from { opacity: 0.001; transform: translate3d(0, 14px, 0); } to { opacity: 1; transform: none; } }

  .p9-float { animation: p9-float 6s ease-in-out infinite; }
  [data-play="off"] .p9-float { animation-play-state: paused; }
  @keyframes p9-float { 0%, 100% { transform: translate3d(0, 0, 0); } 50% { transform: translate3d(0, -10px, 0); } }
  .p9-phone-in { animation: p9-phone-in 1.1s var(--spring) 0.25s both; }
  @keyframes p9-phone-in {
    from { opacity: 0.001; transform: translate3d(0, 60px, 0) scale(0.92) rotateX(18deg); }
    to { opacity: 1; transform: none; }
  }
  .p9-pop { animation: p9-pop 0.42s var(--spring) both; }
  @keyframes p9-pop {
    from { opacity: 0; transform: translate3d(0, 10px, 0) scale(0.92); }
    to { opacity: 1; transform: none; }
  }
  .p9-dots i { animation: p9-dot 1.1s ease-in-out infinite; }
  .p9-dots i:nth-child(2) { animation-delay: 0.15s; }
  .p9-dots i:nth-child(3) { animation-delay: 0.3s; }
  @keyframes p9-dot { 0%, 60%, 100% { transform: translateY(0); opacity: 0.5; } 30% { transform: translateY(-4px); opacity: 1; } }
  .p9-chip[aria-pressed="true"] .p9-chip-fill { animation: p9-fill var(--dur, 8s) linear both; }
  [data-play="off"] .p9-chip-fill { animation-play-state: paused; }
  @keyframes p9-fill { from { transform: scaleX(0); } to { transform: scaleX(1); } }

  /* data-in is set only by the page's script: the server's HTML (and no-JS) shows everything. */
  .p9-rise { transition: opacity 0.8s var(--ease), transform 0.8s var(--ease); transition-delay: var(--d, 0ms); }
  .p9-rise[data-in="false"] { opacity: 0.001; transform: translate3d(0, 26px, 0); }
  .p9-par { transform: translate3d(0, calc(var(--sy, 0) * 1px), 0); will-change: transform; }

  [data-in="false"] .p9-draw { stroke-dashoffset: 1; }
  [data-in="true"] .p9-draw { transition: stroke-dashoffset 1.4s var(--ease); transition-delay: var(--d, 0ms); stroke-dashoffset: 0; }
  [data-in="false"] .p9-line { transform: scaleY(0); }
  [data-in="true"] .p9-line { transition: transform 1.6s var(--ease) 0.2s; transform: scaleY(1); }

  .p9-stamp-ring { animation: p9-spin 22s linear infinite; }
  [data-play="off"] .p9-stamp-ring { animation-play-state: paused; }
  @keyframes p9-spin { to { transform: rotate(360deg); } }

  .p9-confetti i { animation: p9-fall 1.6s cubic-bezier(0.2, 0.7, 0.4, 1) forwards; animation-delay: var(--d, 0ms); }
  @keyframes p9-fall {
    0% { opacity: 1; transform: translate3d(0, 0, 0) rotate(0); }
    100% { opacity: 0; transform: translate3d(var(--x, 0), 105vh, 0) rotate(var(--r, 540deg)); }
  }
  .p9-check-circle { stroke-dasharray: 1; stroke-dashoffset: 1; animation: p9-draw-in 0.6s var(--ease) 0.1s forwards; }
  .p9-check-mark { stroke-dasharray: 1; stroke-dashoffset: 1; animation: p9-draw-in 0.45s var(--ease) 0.55s forwards; }
  @keyframes p9-draw-in { to { stroke-dashoffset: 0; } }
  .p9-shake { animation: p9-shake 0.42s ease-in-out; }
  @keyframes p9-shake { 0%,100% { transform: none; } 20%,60% { transform: translateX(-6px); } 40%,80% { transform: translateX(6px); } }
}
`;
