/**
 * Register pdfkit's 14 standard fonts from JS modules instead of the package directory.
 * The production worker is a single tsup bundle, where pdfkit can't read its font files from disk
 * (pdfkit's documented fix). react-pdf preloads every standard family at startup, so all 14 are
 * registered, not just the ones our templates use. MUST be imported before @react-pdf/renderer.
 */
import { registerStdFonts } from "pdfkit";
import Courier from "pdfkit/standard-fonts/Courier";
import CourierBold from "pdfkit/standard-fonts/CourierBold";
import CourierBoldOblique from "pdfkit/standard-fonts/CourierBoldOblique";
import CourierOblique from "pdfkit/standard-fonts/CourierOblique";
import Helvetica from "pdfkit/standard-fonts/Helvetica";
import HelveticaBold from "pdfkit/standard-fonts/HelveticaBold";
import HelveticaBoldOblique from "pdfkit/standard-fonts/HelveticaBoldOblique";
import HelveticaOblique from "pdfkit/standard-fonts/HelveticaOblique";
import Symbol from "pdfkit/standard-fonts/Symbol";
import TimesBold from "pdfkit/standard-fonts/TimesBold";
import TimesBoldItalic from "pdfkit/standard-fonts/TimesBoldItalic";
import TimesItalic from "pdfkit/standard-fonts/TimesItalic";
import TimesRoman from "pdfkit/standard-fonts/TimesRoman";
import ZapfDingbats from "pdfkit/standard-fonts/ZapfDingbats";

registerStdFonts(
  Courier, CourierBold, CourierBoldOblique, CourierOblique, Helvetica, HelveticaBold, HelveticaBoldOblique, HelveticaOblique, Symbol, TimesBold, TimesBoldItalic, TimesItalic, TimesRoman, ZapfDingbats,
);
