import { useEffect, useState } from "react";
import { GitHub } from "./Icons";
import { Logo } from "./Logo";

/**
 * True once the page has moved at all. The threshold is a couple of pixels
 * rather than zero so a trackpad's rubber-banding does not flicker the bar.
 */
function useScrolled(threshold = 6) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const read = () => setScrolled(window.scrollY > threshold);

    // Run once on mount: a reload can restore a scroll position, and the bar
    // would otherwise stay clear until the first scroll event.
    read();
    window.addEventListener("scroll", read, { passive: true });

    return () => window.removeEventListener("scroll", read);
  }, [threshold]);

  return scrolled;
}

/**
 * Cal.com's bar, with our items in it: the wordmark hard left, plain text links
 * on the right, and a near-black pill as the last item. Clear over the page at
 * rest; once the page moves it sticks to the top and frosts, so the panel
 * scrolling underneath stays readable behind it.
 */
export function Nav({ repo }: { repo: string }) {
  const scrolled = useScrolled();

  return (
    <header className="nav" data-scrolled={scrolled}>
      <a
        className="brand"
        href={repo}
        target="_blank"
        rel="noreferrer"
        aria-label="Woopcode"
      >
        <Logo />
      </a>

      <nav className="nav__links" aria-label="Main">
        {/* Same origin, so no target/rel: the docs are part of this site now,
            not somewhere else the reader is being sent. */}
        <a className="nav__link" href="/docs">
          Docs
        </a>

        <a
          className="nav__link"
          href={`${repo}#readme`}
          target="_blank"
          rel="noreferrer"
        >
          About
        </a>

        <a
          className="nav__cta"
          href={repo}
          target="_blank"
          rel="noreferrer"
        >
          <GitHub size={15} />
          GitHub
        </a>
      </nav>
    </header>
  );
}
