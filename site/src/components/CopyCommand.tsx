import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "./Icons";
import { ScrambleText } from "./ScrambleText";

/** Bun first: it is what the CLI is built on and what the note below asks for. */
const MANAGERS = [
  { id: "bun", label: "bun", command: "bun add -g woopcode" },
  { id: "npm", label: "npm", command: "npm install -g woopcode" },
] as const;

async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context; fall back to a throwaway textarea.
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.appendChild(field);
    field.select();
    const ok = document.execCommand("copy");
    field.remove();
    return ok;
  }
}

/**
 * The install command sitting in a field, with the copy action as the primary
 * button beside it, and a pill above that switches which package runner the
 * command is written for. Clicking either half of the field copies.
 */
export function InstallRow() {
  const [managerIndex, setManagerIndex] = useState(0);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const command = MANAGERS[managerIndex]!.command;

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    if (!(await writeClipboard(command))) return;
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1800);
  };

  const select = (index: number) => {
    setManagerIndex(index);
    // The old command is no longer what is on the clipboard's label, so drop
    // the confirmation rather than let it describe the wrong thing.
    setCopied(false);
    clearTimeout(timer.current);
  };

  return (
    <div
      className="install"
      data-reveal
      style={{ "--reveal-delay": "130ms" } as React.CSSProperties}
    >
      <div
        className="switch"
        role="tablist"
        aria-label="Package runner"
        style={{ "--count": MANAGERS.length } as React.CSSProperties}
      >
        <span
          className="switch__thumb"
          aria-hidden="true"
          style={{ "--index": managerIndex } as React.CSSProperties}
        />

        {MANAGERS.map((manager, index) => (
          <button
            key={manager.id}
            type="button"
            role="tab"
            className="switch__option"
            aria-selected={index === managerIndex}
            onClick={() => select(index)}
          >
            {manager.label}
          </button>
        ))}
      </div>

      <div className="install__row">
        <button
          type="button"
          className="install__field"
          onClick={copy}
          aria-label={`Copy ${command} to clipboard`}
        >
          <span className="install__prompt">$</span>
          {/* Hidden from assistive tech: mid-morph this is deliberate noise,
              and the button's aria-label already carries the real command. */}
          <span className="install__command" aria-hidden="true">
            <ScrambleText value={command} />
          </span>
          <span className="install__hint" data-copied={copied}>
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </span>
        </button>

        <button type="button" className="install__go" onClick={copy}>
          {copied ? "Copied !" : "Copy"}
        </button>
      </div>
    </div>
  );
}
