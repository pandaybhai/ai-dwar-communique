import { useEffect, useRef } from "react";
import { useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

/**
 * After Magic UI's confetti (magicui.design), drawn on our own canvas so it
 * needs no extra package (Batch 57): one burst of the brand colours when
 * `fire` turns true, then nothing. It never repeats for the same mount and
 * draws nothing under reduced motion. Decorative: hidden from screen readers.
 */
const COLOURS = ["--gold", "--aiden", "--foreground", "--av1", "--av2"];

export function ConfettiBurst({ fire, className }: { fire: boolean; className?: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const done = useRef(false);
  const reduce = useReducedMotion();

  useEffect(() => {
    const canvas = ref.current;
    if (!fire || done.current || reduce || !canvas) return;
    done.current = true;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.scale(dpr, dpr);
    const style = getComputedStyle(canvas);
    const colours = COLOURS.map((c) => style.getPropertyValue(c).trim() || "#0F9D74");
    const parts = Array.from({ length: 70 }, (_, i) => ({
      x: w / 2,
      y: h * 0.75,
      vx: (Math.random() - 0.5) * 9,
      vy: -(Math.random() * 7 + 5),
      r: Math.random() * 4 + 2,
      c: colours[i % colours.length]!,
      a: 1,
    }));
    let frame = 0;
    const started = performance.now();
    const tick = (t: number) => {
      ctx.clearRect(0, 0, w, h);
      let alive = false;
      for (const p of parts) {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.25;
        p.a -= 0.012;
        if (p.a <= 0) continue;
        alive = true;
        ctx.globalAlpha = p.a;
        ctx.fillStyle = p.c;
        ctx.fillRect(p.x, p.y, p.r, p.r * 1.6);
      }
      if (alive && t - started < 2500) frame = requestAnimationFrame(tick);
      else ctx.clearRect(0, 0, w, h);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [fire, reduce]);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-0 h-full w-full", className)}
    />
  );
}
