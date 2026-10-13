// Type shim for the vendored @xterm/xterm 6.0.0 bundle. It lists only what Porthole's terminal view uses;
// without this file, `checkJs` would type-check the minified vendor bundle itself.
export interface Disposable {
  dispose(): void;
}

export interface TerminalTheme {
  background?: string;
  foreground?: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
  selectionForeground?: string;
}

export interface TerminalOptions {
  cursorBlink?: boolean;
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  macOptionIsMeta?: boolean;
  minimumContrastRatio?: number;
  scrollback?: number;
  theme?: TerminalTheme;
}

export interface TerminalAddon extends Disposable {
  activate(terminal: Terminal): void;
}

export interface BufferNamespace {
  readonly active: {
    readonly viewportY: number;
    readonly baseY: number;
  };
}

export declare class Terminal {
  constructor(options?: TerminalOptions);
  readonly element: HTMLElement | undefined;
  readonly textarea: HTMLTextAreaElement | undefined;
  readonly cols: number;
  readonly rows: number;
  readonly buffer: BufferNamespace;
  readonly modes: {
    readonly applicationCursorKeysMode: boolean;
    readonly mouseTrackingMode: "none" | "x10" | "vt200" | "drag" | "any";
  };
  options: TerminalOptions;
  open(parent: HTMLElement): void;
  loadAddon(addon: TerminalAddon): void;
  onData(listener: (data: string) => void): Disposable;
  onBinary(listener: (data: string) => void): Disposable;
  onResize(listener: (size: { cols: number; rows: number }) => void): Disposable;
  write(data: string | Uint8Array, callback?: () => void): void;
  paste(data: string): void;
  reset(): void;
  focus(): void;
  blur(): void;
  scrollLines(amount: number): void;
  scrollToBottom(): void;
  scrollToLine(line: number): void;
  dispose(): void;
}
