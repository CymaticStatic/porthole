// Type shim for the vendored @xterm/addon-fit 0.11.0 bundle. Without this file, `checkJs` would
// type-check the minified vendor bundle itself.
import type { Terminal, TerminalAddon } from "../../xterm/lib/xterm.mjs";

export declare class FitAddon implements TerminalAddon {
  constructor();
  activate(terminal: Terminal): void;
  dispose(): void;
  fit(): void;
  proposeDimensions(): { cols: number; rows: number } | undefined;
}
