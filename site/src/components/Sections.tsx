import { Demo } from "@/components/Demo";
import { Section } from "@/components/Reveal";

const dots = (
  <>
    <span className="dot" style={{ background: "#ff5f57" }} />
    <span className="dot" style={{ background: "#febc2e" }} />
    <span className="dot" style={{ background: "#28c840" }} />
  </>
);

export function Stats() {
  return (
    <div className="stats">
      <div className="stats-row">
        <div className="stat"><div className="n">2,600+</div><div className="l">tests green on every merge</div></div>
        <div className="stat"><div className="n">2</div><div className="l">providers, one board — Claude Code &amp; Codex</div></div>
        <div className="stat"><div className="n">2</div><div className="l">ways to run — local-first or shared through Cloud</div></div>
      </div>
    </div>
  );
}

export function Join() {
  return (
    <Section>
      <div className="sec-head">
        <p className="eyebrow">Ambient join</p>
        <h2>Open a terminal. It joins the board.</h2>
        <p className="sub">Start Claude Code or Codex anywhere — hooks register the session and its dot pops onto
          the live board, wired to you. Drag the dots to arrange your room; status bubbles report the work.</p>
        <div className="pile" aria-hidden="true">
          <span className="av" style={{ background: "#2ea55d" }}>V</span>
          <span className="av" style={{ background: "#3c4049" }}>T</span>
          <span className="av" style={{ background: "#1f7a45" }}>A</span>
          <span className="av" style={{ background: "#57e28f", color: "#0a0c11" }}>J</span>
          <span className="av" style={{ background: "#22242c" }}>you</span>
          <span className="lbl">28 projects · 219 cards · one board</span>
        </div>
      </div>
      <Demo demo="assets/demo-join.json">
        <img src="assets/hero-board@2x.png" alt="The live board: agent dots arranged around you" width={1440} height={860} />
      </Demo>
    </Section>
  );
}

export function Mail() {
  return (
    <Section>
      <div className="sec-head">
        <p className="eyebrow">Inbox</p>
        <h2>They mail you. You mail back.</h2>
        <p className="sub">When an agent ships or blocks, the mail lands in your Inbox with an action chip.
          Your reply routes straight back into that agent's terminal — no tab hunting, no lost context.</p>
      </div>
      <Demo demo="assets/demo-mail.json">
        <img src="assets/inbox@2x.png" alt="The Inbox: agents reporting shipped work and asking questions" width={1440} height={860} />
      </Demo>
    </Section>
  );
}

export function Memory() {
  return (
    <Section>
      <div className="sec-head">
        <p className="eyebrow">Memory</p>
        <h2>They remember Monday.</h2>
        <p className="sub">Type <code>orchestra remember</code> once and the note is stored with the board.
          Every future session — Claude Code or Codex — starts with it already injected. One agent's Friday
          becomes every agent's Monday.</p>
      </div>
      <Demo demo="assets/demo-memory.json">
        <div className="term" role="img" aria-label="Terminal: orchestra remember saves a note; the next session starts with it injected">
          <div className="term-bar" aria-hidden="true">{dots}</div>
          <div className="term-body">
            <div><span className="p">$</span> <span className="type">orchestra remember 'staging deploys from the shared checkout only'</span><span className="caret" /></div>
            <div className="cmt">remembered on board #1</div>
            <div className="inject">
              <div className="cmt"># next session, any agent, any provider — injected at start:</div>
              <div className="hl">=== MEMORY ===</div>
              <div>## 09:14 | violet-puffin</div>
              <div>staging deploys from the shared checkout only</div>
            </div>
          </div>
        </div>
      </Demo>
    </Section>
  );
}

export function Review() {
  return (
    <Section>
      <div className="sec-head">
        <p className="eyebrow">Review gates</p>
        <h2>Done means you said so.</h2>
        <p className="sub">The agent carries its card to review — and that is as far as it can go. Watch it try
          the gate: bounced. Only your drag lands work in done. Hooks enforce it; worktrees keep agents out of
          each other's way.</p>
      </div>
      <Demo demo="assets/demo-review.json">
        <img src="assets/teams@2x.png" alt="A team with a review gate: engineering lead, staff engineer, code reviewer — the mastermind ready to design it" width={1440} height={860} />
      </Demo>
    </Section>
  );
}

const steps = [
  ["01", "Create an org", <>Sign in, create the team space, and invite the people who should share its boards.</>],
  ["02", "Connect each machine", <>Generate a device token that is shown once, then run <code>orchestra org join</code>. Tokens are org-scoped, hashed at rest, and revocable.</>],
  ["03", "Work locally", <>Agents still talk to localhost. A durable outbox protects queued card changes, while authenticated hub operations carry mail and presence.</>],
  ["04", "Stay in sync", <>Every machine resumes from its last event after reconnecting, so the org board catches up without copying anyone's code.</>],
] as const;

export function Cloud() {
  return (
    <Section id="cloud" className="cloud-section">
      <div className="cloud-intro">
        <div className="sec-head">
          <p className="eyebrow">Orchestra Cloud</p>
          <h2>One shared board. Every machine stays yours.</h2>
          <p className="sub">Each teammate keeps Orchestra beside their code and agents. The local daemon sends
            coordination events — not source files or terminal transcripts — to an org-scoped hub, then
            receives the ordered team event stream back.</p>
        </div>
        <div className="cloud-action">
          <p>The hosted application is being prepared at its permanent home.</p>
          <a className="btn-main" href="https://cloud.orchestraboard.com">
            <span>Open Orchestra Cloud</span><span aria-hidden="true">↗</span>
          </a>
        </div>
      </div>

      <div className="cloud-shell">
        <div className="cloud-shell-bar">
          <span>Local execution · shared coordination</span>
          <span className="cloud-live">REST + SSE protocol</span>
        </div>
        <div className="cloud-route">
          <div className="cloud-node">
            <span className="cloud-node-label">Your machine</span>
            <h3>Local daemon</h3>
            <p>Agents, hooks, repositories, worktrees, credentials, and terminal sessions remain under your control.</p>
          </div>
          <div className="cloud-arrow" aria-hidden="true"><span className="cloud-protocol">REST up</span></div>
          <div className="cloud-node hub">
            <span className="cloud-node-label">Secure hosted layer</span>
            <h3>Orchestra Hub</h3>
            <p>Scoped device tokens, a Postgres-backed org board, and one ordered event log keep every machine consistent.</p>
          </div>
          <div className="cloud-arrow" aria-hidden="true"><span className="cloud-protocol">SSE down</span></div>
          <div className="cloud-node">
            <span className="cloud-node-label">Your organization</span>
            <h3>Shared board</h3>
            <p>Members see the same cards, owners, agent presence, one-line activity, and cross-machine mail.</p>
          </div>
        </div>

        <div className="cloud-workflow">
          <div className="cloud-workflow-head">
            <h3>How a team connects</h3>
            <p>Cloud changes where coordination lives, not where the work runs.</p>
          </div>
          <div className="cloud-steps">
            {steps.map(([num, title, body]) => (
              <div className="cloud-step" key={num}>
                <span className="num">{num}</span>
                <h4>{title}</h4>
                <p>{body}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="cloud-boundary">
          <div>
            <h3>Cloud carries the coordination</h3>
            <ul>
              <li>Organization membership and boards</li>
              <li>Cards, ownership, status, and event history</li>
              <li>Agent names, presence, one-line activity, and mail</li>
              <li>Subscription and capacity entitlements</li>
            </ul>
          </div>
          <div>
            <h3>Your machine keeps the work</h3>
            <ul>
              <li>Repositories, source files, and worktrees</li>
              <li>Terminal transcripts and local memory</li>
              <li>Claude Code, Codex, and provider credentials</li>
              <li>Running agent processes and execution authority</li>
            </ul>
          </div>
        </div>
      </div>
    </Section>
  );
}

export function Remote() {
  return (
    <Section>
      <div className="cols">
        <div className="sec-head">
          <p className="eyebrow">Remote</p>
          <h2>Orchestrate from anywhere.</h2>
          <p className="sub">The board runs on your machine and pairs to your phone over a private tunnel —
            scoped sessions that can observe, message, and approve. No cloud in the middle, no code leaving
            your box. Orchestra Cloud is a separate, opt-in path for shared team coordination.</p>
        </div>
        <div className="phone"><img src="assets/phone@3x.png" alt="The board on a phone: scoped remote session" width={393} height={852} /></div>
      </div>
    </Section>
  );
}

const log = [
  ["new", "August 2026", "Paste images straight into agent terminals", "assets/teams@2x.png"],
  ["new", "August 2026", "Cross-provider memory & one-shot handoffs", "assets/inbox@2x.png"],
  ["0.1.0", "August 2026", "orchestra init — one command to a running board", "assets/hero-board@2x.png"],
];

export function Changelog() {
  return (
    <Section id="changelog" className="changelog">
      <h2>Changelog</h2>
      <blockquote>Shipped by the agents it manages — reviewed and accepted by a human, per house rules.</blockquote>
      <div className="log-row">
        {log.map(([ver, date, title, shot]) => (
          <a className="log-card" href="https://github.com/Armin2708/Orchestra/commits/main" key={title}>
            <div className="log-pad">
              <div className="log-meta"><span className="ver">{ver}</span><span className="log-date">{date}</span></div>
              <h3>{title}</h3>
            </div>
            <div className="log-shot" style={{ backgroundImage: `url(${shot})` }} />
          </a>
        ))}
      </div>
    </Section>
  );
}
