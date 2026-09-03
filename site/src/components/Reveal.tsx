import { motion } from "framer-motion";
import type { ReactNode } from "react";

/**
 * A page section that rises into view as the strings sweep past it. framer's whileInView
 * replaces the old `.reveal` IntersectionObserver so the motion is one spring system with
 * the hero and the scroll-driven strings.
 */
export function Section({ id, className, children }: { id?: string; className?: string; children: ReactNode }) {
  return (
    <section id={id} className={className}>
      <motion.div
        className="sec"
        initial={{ opacity: 0, y: 48 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "0px 0px -120px 0px" }}
        transition={{ type: "spring", stiffness: 70, damping: 18, mass: 0.8 }}
      >
        {children}
      </motion.div>
    </section>
  );
}
