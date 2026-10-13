// Type shim for the vendored marked 18.1.1 bundle. Porthole uses only `marked.lexer`;
// without this file, `checkJs` would type-check the minified vendor bundle itself.
export interface MarkedToken {
  type: string;
  raw: string;
  text?: string;
  tokens?: MarkedToken[];
  items?: MarkedToken[];
  [field: string]: unknown;
}

export declare const marked: {
  lexer(src: string): MarkedToken[];
};
