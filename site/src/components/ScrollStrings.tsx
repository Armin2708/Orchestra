import { motion, useScroll, useSpring, useTransform, type MotionValue } from "framer-motion";
import { floatingPathsData } from "@/components/ui/background-paths";

/**
 * The hero's two string fans on a fixed full-viewport layer behind the whole page, driven by
 * scroll instead of a timer:
 *
 * - `progress` is the scroll position through a spring, so the strings glide and settle.
 * - each string's dash offset is progress × its own rate (+ a phase), so scrolling down makes
 *   the strings travel down their curves at slightly different speeds, and scrolling up
 *   brings them back the same way. Nothing moves when you are not scrolling.
 * - the dash grows longer the further down the page you are, and the fans slide apart /
 *   tilt / dim a little so text over them stays readable.
 *
 * The paths only fade in on load (no draw-in timer), so there is no ambient animation to
 * fight the scroll.
 */
const PX_PER_CYCLE = 1400;

function ScrollString({ d, width, id, progress, length }: { d: string; width: number; id: number; progress: MotionValue<number>; length: MotionValue<number> }) {
  const rate = 0.7 + (id % 6) * 0.12;
  const phase = (id * 0.037) % 1;
  const pathOffset = useTransform(progress, (v) => v * rate + phase);
  return (
    <motion.path
      d={d}
      stroke="currentColor"
      strokeWidth={width}
      strokeOpacity={0.1 + id * 0.03}
      style={{ pathOffset, pathLength: length }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 0.6 }}
      transition={{ duration: 1.6, delay: id * 0.02 }}
    />
  );
}

function ScrollFan({ position, progress, length }: { position: number; progress: MotionValue<number>; length: MotionValue<number> }) {
  const paths = floatingPathsData(position);
  return (
    <div className="absolute inset-0 pointer-events-none">
      <svg className="w-full h-full text-slate-950 dark:text-white" viewBox="0 0 696 316" fill="none">
        <title>Background Paths</title>
        {paths.map((p) => <ScrollString key={p.id} d={p.d} width={p.width} id={p.id} progress={progress} length={length} />)}
      </svg>
    </div>
  );
}

export function ScrollStrings() {
  const { scrollY } = useScroll();
  const smooth = useSpring(scrollY, { stiffness: 50, damping: 18, mass: 0.8 });
  const progress = useTransform(smooth, (v) => v / PX_PER_CYCLE);
  const length = useTransform(smooth, [0, 4000], [0.42, 0.85]);

  const yA = useTransform(smooth, [0, 3200], [0, -420]);
  const xA = useTransform(smooth, [0, 3200], [0, -160]);
  const rA = useTransform(smooth, [0, 3200], [0, -7]);
  const yB = useTransform(smooth, [0, 3200], [0, 320]);
  const xB = useTransform(smooth, [0, 3200], [0, 140]);
  const rB = useTransform(smooth, [0, 3200], [0, 6]);
  const opacity = useTransform(smooth, [0, 700, 1400], [1, 0.75, 0.55]);

  return (
    <motion.div aria-hidden="true" style={{ opacity }} className="fixed inset-0 z-0 pointer-events-none overflow-hidden">
      <motion.div style={{ x: xA, y: yA, rotate: rA }} className="absolute inset-0 origin-center">
        <ScrollFan position={1} progress={progress} length={length} />
      </motion.div>
      <motion.div style={{ x: xB, y: yB, rotate: rB }} className="absolute inset-0 origin-center">
        <ScrollFan position={-1} progress={progress} length={length} />
      </motion.div>
    </motion.div>
  );
}
