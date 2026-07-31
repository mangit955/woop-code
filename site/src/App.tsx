import { Backdrop } from "./components/Backdrop";
import { Band } from "./components/Band";
import { InstallRow } from "./components/CopyCommand";
import { Nav } from "./components/Nav";
import { Scene } from "./components/Scene";

const VERSION = "0.6.0";
const REPO = "https://github.com/mangit955/woop-code";

export function App() {
  return (
    <div className="shell">
      <div className="frame">
        <Nav repo={REPO} />

        <main className="page">
          {/* One field across the whole panel, ramping from a whisper on the
              left to full strength under the artwork on the right. */}
          <Backdrop strengthLeft={0.3} strengthRight={1} focusX={0.74} />

          <section className="pane">
            <div className="lede">
              <h2 data-reveal>A coding agent that shows its work.</h2>

              <p
                className="lede__sub"
                data-reveal
                style={{ "--reveal-delay": "70ms" } as React.CSSProperties}
              >
                Woopcode runs in your terminal, reads the repository you are in,
                and pauses on a diff before it changes a single line.
              </p>

              <InstallRow />

              <p
                className="lede__note"
                data-reveal
                style={{ "--reveal-delay": "180ms" } as React.CSSProperties}
              >
                Requires Bun 1.0+. Free and open source, MIT licensed.
              </p>
            </div>
          </section>

          <Scene />
        </main>
      </div>

      <Band repo={REPO} version={VERSION} />
    </div>
  );
}
