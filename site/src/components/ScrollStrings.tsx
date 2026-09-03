import { useEffect, useState } from "react";
import { motion, useScroll, useSpring, useTransform, type MotionValue } from "framer-motion";

/**
 * A ribbon of 36 strings that snakes down the entire page in an S: it sweeps across the
 * hero, turns at the first section and runs down one margin, crosses to the other side
 * between sections, and so on to the footer. Scrolling draws it: the strings' pathLength
 * follows a spring-smoothed scroll position, so the ribbon runs ahead of you as you scroll
 * down and retracts when you scroll up.
 *
 * Anchors are measured from the real DOM (each <section> top) so the turns land in the
 * gaps between sections, where nothing covers them.
 */
const N = 36;
type Pt = [number, number];

function measure(): { W: number; H: number; anchors: Pt[] } {
  const W = window.innerWidth, vh = window.innerHeight;
  const H = document.documentElement.scrollHeight;
  const tops = [...document.querySelectorAll("main section, main .final")].map((el) => el.getBoundingClientRect().top + window.scrollY);
  const anchors: Pt[] = [
    [-0.12 * W, 0.16 * vh],           // enter from the top-left, above the headline
    [0.42 * W, 0.62 * vh],            // sweep down across the hero
    [1.08 * W, 0.98 * vh],            // exit right under the CTA…
  ];
  tops.forEach((top, k) => anchors.push([k % 2 === 0 ? 0.92 * W : 0.08 * W, top - 30]));  // …then alternate margins
  anchors.push([0.5 * W, H + 120]);
  return { W, H, anchors };
}

/** Catmull-Rom through the anchors → cubic Bézier path. Each string is a slightly offset, slightly wider copy. */
function ribbonPath(anchors: Pt[], i: number, W: number): string {
  const k = (i - N / 2) / (N / 2);                       // -1..1 across the ribbon
  // spread: strings fan out ~450px across and drift along the ribbon; the outer ones swing
  // wider on the turns, and a per-string wobble makes neighbours cross and re-cross so the
  // bundle reads as loose strings (like the hero fan), not one solid band
  const wobble = Math.sin(i * 1.7) * 0.16, drift = Math.sin(i * 2.3) * 70;
  const pts: Pt[] = anchors.map(([x, y], j) => [
    W / 2 + (x - W / 2) * (1 + k * 0.26 + wobble * (j % 2 ? 1 : -1)) + k * 220,
    y + k * 120 + drift * (j % 3 === 1 ? -1 : 1) + k * (j % 2 ? 50 : -50),
  ]);
  const n = pts.length;
  const at = (j: number) => pts[Math.max(0, Math.min(n - 1, j))];
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let j = 0; j < n - 1; j++) {
    const p0 = at(j - 1), p1 = at(j), p2 = at(j + 1), p3 = at(j + 2);
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)} ${c1[1].toFixed(1)}, ${c2[0].toFixed(1)} ${c2[1].toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

function String_({ d, i, head }: { d: string; i: number; head: MotionValue<number> }) {
  // the tips stagger a little so the ribbon's front is a soft edge, not a hard line
  const pathLength = useTransform(head, (v) => Math.max(0.001, Math.min(1, v * (0.94 + (i % 7) * 0.012))));
  return (
    <motion.path
      d={d}
      stroke="currentColor"
      strokeWidth={0.5 + i * 0.03}
      strokeOpacity={0.1 + i * 0.03}
      strokeLinecap="round"
      style={{ pathLength }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 0.6 }}
      transition={{ duration: 1.6, delay: i * 0.02 }}
    />
  );
}

export function ScrollStrings() {
  const [geo, setGeo] = useState<{ W: number; H: number; anchors: Pt[] } | null>(null);
  useEffect(() => {
    let raf = 0;
    const update = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => setGeo(measure())); };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(document.documentElement);
    document.querySelector("main") && ro.observe(document.querySelector("main")!);
    window.addEventListener("resize", update);
    return () => { ro.disconnect(); window.removeEventListener("resize", update); cancelAnimationFrame(raf); };
  }, []);

  const { scrollY } = useScroll();
  const smooth = useSpring(scrollY, { stiffness: 50, damping: 18, mass: 0.8 });
  // drawn fraction: the ribbon runs one viewport ahead of the top of the screen
  const head = useTransform(smooth, (y) => (geo ? (y + window.innerHeight * 1.05) / geo.H : 0));

  if (!geo) return null;
  return (
    <div aria-hidden="true" className="absolute inset-x-0 top-0 z-0 pointer-events-none overflow-hidden" style={{ height: geo.H }}>
      <svg className="w-full h-full text-slate-950 dark:text-white" viewBox={`0 0 ${geo.W} ${geo.H}`} preserveAspectRatio="none" fill="none">
        <title>Background Paths</title>
        {Array.from({ length: N }, (_, i) => <String_ key={i} i={i} d={ribbonPath(geo.anchors, i, geo.W)} head={head} />)}
      </svg>
    </div>
  );
}
