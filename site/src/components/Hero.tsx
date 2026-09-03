import { motion } from "framer-motion";
import { BackgroundPaths } from "@/components/ui/background-paths";
import { Button } from "@/components/ui/button";

const cursors = [
  { cls: "c1", fill: "#45e07f", tag: "#2ea55d", name: "violet-puffin" },
  { cls: "c2", fill: "#e9ebf2", tag: "#3c4049", name: "teal-ibex" },
  { cls: "c3", fill: "#7ef0a8", tag: "#1f7a45", name: "amber-raven" },
];

export function Hero() {
  return (
    <div className="hero dark">
      <BackgroundPaths
        title="Run a team of coding agents that coordinate."
        ctaLabel="Get Orchestra"
        ctaHref="#install"
        secondary={
          <Button
            asChild
            variant="ghost"
            className="rounded-[1.15rem] px-8 py-6 text-lg font-medium text-white/85 hover:text-white border border-white/10 hover:bg-white/5"
          >
            <a href="#cloud">Explore Orchestra Cloud</a>
          </Button>
        }
      >
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.9, duration: 0.9, ease: [0.2, 0.7, 0.2, 1] }}
          className="relative z-10 w-full"
        >
          <div className="hero-inner" style={{ paddingTop: 0 }}>
            <p className="lede">
              A live board where Claude Code and Codex agents work together — mail, memory, and review gates — on
              your machine or across your team through Orchestra Cloud. You orchestrate; they play.
            </p>
            <p className="hero-note">npm i -g orchestra-board · FSL licensed · macOS &amp; Linux</p>

            <div className="stage">
              <div className="window">
                <div className="window-bar" aria-hidden="true">
                  <span className="dot" style={{ background: "#ff5f57" }} />
                  <span className="dot" style={{ background: "#febc2e" }} />
                  <span className="dot" style={{ background: "#28c840" }} />
                </div>
                <img
                  src="assets/hero-board@2x.png"
                  alt="The Orchestra board: violet-puffin reporting shipped work around you, ready for the next ask"
                  width={1440}
                  height={860}
                />
                {cursors.map((c) => (
                  <div key={c.cls} className={`cursor ${c.cls}`} aria-hidden="true">
                    <svg width="15" height="15" viewBox="0 0 15 15">
                      <path d="M1 1 L1 12 L4.2 9.2 L6.2 13.6 L8.4 12.6 L6.4 8.4 L10.5 8 Z" fill={c.fill} stroke="#0a0c11" strokeWidth="1" />
                    </svg>
                    <span className="tag" style={{ background: c.tag }}>{c.name}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </motion.div>
      </BackgroundPaths>
    </div>
  );
}
