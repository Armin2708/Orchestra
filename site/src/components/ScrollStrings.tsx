import { motion, useScroll, useSpring, useTransform } from "framer-motion";
import { FloatingPaths } from "@/components/ui/background-paths";

/**
 * The hero's two string fans, rendered once on a fixed full-viewport layer behind the whole
 * page. At scroll 0 the geometry is identical to the in-hero version (fixed inset-0 == the
 * min-h-screen hero box). Scrolling drives a slow, spring-smoothed sweep: the fans slide
 * apart and tilt so the strings appear to lead the eye down past each section, and dim a
 * little once the copy sections start so text stays readable. The per-string flow
 * animation is untouched (framer, mirrored). position: fixed makes this its own
 * compositor layer, so the page content does not re-paint when the strings do.
 */
export function ScrollStrings() {
  const { scrollY } = useScroll();
  const smooth = useSpring(scrollY, { stiffness: 60, damping: 22, mass: 0.6 });

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
        <FloatingPaths position={1} />
      </motion.div>
      <motion.div style={{ x: xB, y: yB, rotate: rB }} className="absolute inset-0 origin-center">
        <FloatingPaths position={-1} />
      </motion.div>
    </motion.div>
  );
}
