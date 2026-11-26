// pdfkit ships no types for its bundler-friendly font API (src/server/pdf/fonts.ts).
declare module "pdfkit" {
  export function registerStdFonts(...fonts: unknown[]): void;
}
declare module "pdfkit/standard-fonts/*" {
  const font: unknown;
  export default font;
}
