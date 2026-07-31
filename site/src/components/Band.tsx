/**
 * The strip under the panel: two rules running the full width of the page, and
 * a plus at each of the four points where they cross the rails. Cal.com puts
 * customer logos in here; we have a licence line and a few repository links.
 */
export function Band({ repo, version }: { repo: string; version: string }) {
  return (
    <footer className="band">
      <span className="cross cross--tl" aria-hidden="true" />
      <span className="cross cross--tr" aria-hidden="true" />
      <span className="cross cross--bl" aria-hidden="true" />
      <span className="cross cross--br" aria-hidden="true" />

      <div className="band__inner">
        <p className="band__legal">
          © 2026 Woopcode · v{version} · MIT licensed
        </p>

        <nav className="band__links" aria-label="Repository">
          <a
            className="band__link"
            href={repo}
            target="_blank"
            rel="noreferrer"
          >
            Source
          </a>
          <a
            className="band__link"
            href={`${repo}/releases`}
            target="_blank"
            rel="noreferrer"
          >
            Releases
          </a>
          <a
            className="band__link"
            href={`${repo}/issues`}
            target="_blank"
            rel="noreferrer"
          >
            Issues
          </a>
          <a
            className="band__link"
            href={`${repo}/blob/main/LICENSE`}
            target="_blank"
            rel="noreferrer"
          >
            License
          </a>
        </nav>
      </div>
    </footer>
  );
}
