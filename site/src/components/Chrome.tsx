export function Nav() {
  return (
    <nav>
      <div className="wrap nav-inner">
        <a className="glyph" href="/" aria-label="Orchestra home">
          <img src="assets/orchestra-mark-reversed.svg" alt="" width={34} height={21} aria-hidden="true" />
          <span className="gm">orchestra</span>
        </a>
        <div className="nav-links">
          <a href="#install">Install</a>
          <a href="#cloud">Cloud</a>
          <a href="https://github.com/Armin2708/Orchestra/blob/main/docs/getting-started.md">Docs</a>
          <a href="https://github.com/Armin2708/Orchestra">GitHub</a>
          <a className="nav-cta" href="https://cloud.orchestraboard.com">Open Cloud</a>
        </div>
      </div>
    </nav>
  );
}

export function Footer() {
  return (
    <footer>
      <div className="foot-grid">
        <div>
          <span className="foot-brand">
            <span><img src="assets/orchestra-mark-reversed.svg" alt="" width={38} height={24} aria-hidden="true" />orchestra</span>
            <small>You orchestrate, agents play.<br />© 2026</small>
          </span>
        </div>
        <div>
          <h4>Product</h4>
          <a href="#install">Install</a>
          <a href="#cloud">How Cloud works</a>
          <a href="https://cloud.orchestraboard.com">Open Cloud</a>
          <a href="#changelog">Changelog</a>
          <a href="https://github.com/Armin2708/Orchestra/blob/main/docs/getting-started.md">Docs</a>
        </div>
        <div>
          <h4>Source</h4>
          <a href="https://github.com/Armin2708/Orchestra">GitHub</a>
          <a href="https://github.com/Armin2708/Orchestra/blob/main/LICENSE">License</a>
        </div>
        <div>
          <h4>Works with</h4>
          <a href="https://www.anthropic.com/claude-code">Claude Code</a>
          <a href="https://openai.com/codex">Codex</a>
        </div>
      </div>
    </footer>
  );
}
