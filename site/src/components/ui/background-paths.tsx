"use client";

import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";

/**
 * 21st.dev "Background Paths", adapted for the Orchestra landing hero.
 *
 * Changes from the original:
 * - the SVG sits on its own compositor layer (`will-change: transform`) so the
 *   per-frame dash updates from framer-motion repaint only the strings, not the
 *   whole page. (A CSS mask on that layer stops it painting — use the veil.)
 * - the strings band covers the upper 72% of the hero instead of the whole
 *   box, so the two mirrored fans cross behind the CTA and the veil fades them
 *   into the board window: headline → CTA → board reads as one funnel.
 * - the second fan is mirrored horizontally (the original only nudges x by
 *   ±5·i) so the two fans cross and form a V pointing at the board.
 * - no backdrop-blur: together with 72 animated paths it makes Chromium drop
 *   the page layer in headless/software rendering, and it is invisible on a
 *   95% black button anyway.
 * - every third string takes the brand accent instead of white; odd strings
 *   are hidden below the md breakpoint where the band compresses to a ribbon.
 * - the CTA and anything below the title come from the caller (`children`).
 */
function FloatingPaths({ position, mirror = false }: { position: number; mirror?: boolean }) {
    const paths = Array.from({ length: 36 }, (_, i) => ({
        id: i,
        d: `M-${380 - i * 5 * position} -${189 + i * 6}C-${
            380 - i * 5 * position
        } -${189 + i * 6} -${312 - i * 5 * position} ${216 - i * 6} ${
            152 - i * 5 * position
        } ${343 - i * 6}C${616 - i * 5 * position} ${470 - i * 6} ${
            684 - i * 5 * position
        } ${875 - i * 6} ${684 - i * 5 * position} ${875 - i * 6}`,
        color: `rgba(15,23,42,${0.1 + i * 0.03})`,
        width: 0.5 + i * 0.03,
    }));

    return (
        <div className="absolute inset-x-0 top-0 h-[72%] pointer-events-none will-change-transform [transform:translateZ(0)]">
            <svg
                className={`w-full h-full text-slate-950 dark:text-white ${mirror ? "-scale-x-100" : ""}`}
                viewBox="0 0 696 316"
                fill="none"
            >
                <title>Background Paths</title>
                {paths.map((path) => (
                    <motion.path
                        key={path.id}
                        className={path.id % 2 ? "max-md:hidden" : undefined}
                        d={path.d}
                        stroke={path.id % 3 === 0 ? "var(--accent)" : "currentColor"}
                        strokeWidth={path.width}
                        strokeOpacity={0.1 + path.id * 0.03}
                        initial={{ pathLength: 0.3, opacity: 0.6 }}
                        animate={{
                            pathLength: 1,
                            opacity: [0.3, 0.6, 0.3],
                            pathOffset: [0, 1, 0],
                        }}
                        transition={{
                            duration: 20 + Math.random() * 10,
                            repeat: Number.POSITIVE_INFINITY,
                            ease: "linear",
                        }}
                    />
                ))}
            </svg>
        </div>
    );
}

export function BackgroundPaths({
    title = "Background Paths",
    ctaLabel = "Discover Excellence",
    ctaHref = "#",
    secondary,
    children,
}: {
    title?: string;
    ctaLabel?: string;
    ctaHref?: string;
    secondary?: ReactNode;
    children?: ReactNode;
}) {
    const words = title.split(" ");

    return (
        <div className="relative min-h-screen w-full flex flex-col items-center justify-start overflow-hidden bg-white dark:bg-[#0a0c11]">
            <div className="absolute inset-0">
                <FloatingPaths position={1} />
                <FloatingPaths position={-1} mirror />
                {/* veil: keeps the headline legible and fades the strings into the board window */}
                <div
                    aria-hidden="true"
                    className="absolute inset-0 pointer-events-none"
                    style={{
                        background:
                            "radial-gradient(ellipse 46% 30% at 50% 26%, rgba(10,12,17,.72), rgba(10,12,17,0) 100%), linear-gradient(to bottom, rgba(10,12,17,0) 0%, rgba(10,12,17,0) 52%, rgba(10,12,17,.85) 70%, #0a0c11 78%)",
                    }}
                />
            </div>

            <div className="relative z-10 container mx-auto px-4 md:px-6 text-center pt-24 md:pt-28">
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 2 }}
                    className="max-w-4xl mx-auto"
                >
                    <h1 className="text-5xl sm:text-7xl md:text-8xl font-bold mb-8 tracking-tighter">
                        {words.map((word, wordIndex) => (
                            <span
                                key={wordIndex}
                                className="inline-block mr-4 last:mr-0"
                            >
                                {word.split("").map((letter, letterIndex) => (
                                    <motion.span
                                        key={`${wordIndex}-${letterIndex}`}
                                        initial={{ y: 100, opacity: 0 }}
                                        animate={{ y: 0, opacity: 1 }}
                                        transition={{
                                            delay:
                                                wordIndex * 0.1 +
                                                letterIndex * 0.03,
                                            type: "spring",
                                            stiffness: 150,
                                            damping: 25,
                                        }}
                                        className="inline-block text-transparent bg-clip-text 
                                        bg-gradient-to-r from-neutral-900 to-neutral-700/80 
                                        dark:from-white dark:to-white/80"
                                    >
                                        {letter}
                                    </motion.span>
                                ))}
                            </span>
                        ))}
                    </h1>

                    <div className="flex flex-wrap items-center justify-center gap-4">
                        <div
                            className="inline-block group relative bg-gradient-to-b from-black/10 to-white/10 
                            dark:from-white/10 dark:to-black/10 p-px rounded-2xl 
                            overflow-hidden shadow-lg hover:shadow-xl transition-shadow duration-300"
                        >
                            <Button
                                asChild
                                variant="ghost"
                                className="rounded-[1.15rem] px-8 py-6 text-lg font-semibold 
                                bg-white/95 hover:bg-white/100 dark:bg-black/95 dark:hover:bg-black/100 
                                text-black dark:text-white transition-all duration-300 
                                group-hover:-translate-y-0.5 border border-black/10 dark:border-white/10
                                hover:shadow-md dark:hover:shadow-neutral-800/50"
                            >
                                <a href={ctaHref}>
                                    <span className="opacity-90 group-hover:opacity-100 transition-opacity">
                                        {ctaLabel}
                                    </span>
                                    <span
                                        className="ml-3 opacity-70 group-hover:opacity-100 group-hover:translate-x-1.5 
                                        transition-all duration-300"
                                    >
                                        →
                                    </span>
                                </a>
                            </Button>
                        </div>
                        {secondary}
                    </div>
                </motion.div>
            </div>

            {children}
        </div>
    );
}
