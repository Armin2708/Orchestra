import { BackgroundPaths } from "@/components/ui/background-paths";

const cursors = [
  { cls: "c1", fill: "#45e07f", tag: "#2ea55d", name: "violet-puffin" },
  { cls: "c2", fill: "#e9ebf2", tag: "#3c4049", name: "teal-ibex" },
  { cls: "c3", fill: "#7ef0a8", tag: "#1f7a45", name: "amber-raven" },
];

/** Full-screen Background Paths hero, then the product shot as its own block. */
export function Hero() {
  return (
    <>
      <BackgroundPaths title="Run a team of coding agents that coordinate." ctaLabel="Get Orchestra" ctaHref="#install" variant="none" />

      <div className="hero" style={{ paddingTop: 96, background: "transparent" }}>
        <div className="hero-inner" style={{ paddingTop: 0 }}>
          <p className="lede">
            A live board where Claude Code and Codex agents work together — mail, memory, and review gates — on
            your machine or across your team through Orchestra Cloud. You orchestrate; they play.
          </p>
          <div className="cta-row">
            <a className="btn-ghost" href="#cloud">Explore Orchestra Cloud</a>
          </div>
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
      </div>
    </>
  );
}
