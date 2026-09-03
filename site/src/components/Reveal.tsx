import { Children, isValidElement, type ReactNode } from "react";
import { motion, type Variants } from "framer-motion";

/**
 * A page section whose blocks enter in sequence as it scrolls into view: each direct child
 * (eyebrow/heading group, demo frame, …) fades in, rises, and sharpens from a slight blur,
 * staggered so the copy lands first and the product shot follows.
 */
const container: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.14, delayChildren: 0.05 } },
};
const block: Variants = {
  hidden: { opacity: 0, y: 44, filter: "blur(8px)" },
  show: { opacity: 1, y: 0, filter: "blur(0px)", transition: { type: "spring", stiffness: 60, damping: 16, mass: 0.9 } },
};

export function Section({ id, className, children }: { id?: string; className?: string; children: ReactNode }) {
  return (
    <section id={id} className={className}>
      <motion.div
        className="sec"
        variants={container}
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, margin: "0px 0px -140px 0px" }}
      >
        {Children.map(children, (child, i) =>
          isValidElement(child) ? (
            <motion.div key={i} variants={block} className="contents-block">
              {child}
            </motion.div>
          ) : child,
        )}
      </motion.div>
    </section>
  );
}
