import * as cheerio from "cheerio";
import { extractText as extractPdfText, getDocumentProxy } from "unpdf";

export class UnsupportedDocumentError extends Error {
  readonly format: string;

  constructor(format: string) {
    super(
      `Cannot read text out of a ${format} document. Download it instead, or open it on LEARN.`
    );
    this.name = "UnsupportedDocumentError";
    this.format = format;
  }
}

export interface ExtractedDocument {
  readonly text: string;
  /** Page count for paginated formats, null otherwise. */
  readonly pages: number | null;
}

const extensionOf = (filename: string): string =>
  /\.([A-Za-z0-9]{1,8})$/.exec(filename)?.[1]?.toLowerCase() ?? "unknown";

/** Long runs of blank lines and spaces waste a model's context for nothing. */
function tidy(text: string): string {
  return text
    .replace(/ /g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

const looksLikePdf = (bytes: Uint8Array): boolean =>
  bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // "%PDF"

function htmlToText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();
  return $("body").length ? $("body").text() : $.root().text();
}

/**
 * Turns a downloaded course file into readable text.
 *
 * Sniffs the format from the bytes first, because LEARN serves some files as
 * application/octet-stream.
 */
export async function extractDocumentText(
  bytes: Uint8Array,
  contentType: string,
  filename: string
): Promise<ExtractedDocument> {
  const type = contentType.toLowerCase();
  const extension = extensionOf(filename);

  if (type.includes("pdf") || extension === "pdf" || looksLikePdf(bytes)) {
    // pdf.js posts the buffer to a worker, which transfers and detaches it.
    // Copy first so the caller's bytes stay usable, e.g. to also save the file.
    const document = await getDocumentProxy(new Uint8Array(bytes));
    const { text, totalPages } = await extractPdfText(document, { mergePages: true });
    return { text: tidy(String(text)), pages: totalPages };
  }

  if (type.includes("html") || extension === "html" || extension === "htm") {
    return { text: tidy(htmlToText(Buffer.from(bytes).toString("utf8"))), pages: null };
  }

  if (type.startsWith("text/") || extension === "txt" || extension === "md") {
    return { text: tidy(Buffer.from(bytes).toString("utf8")), pages: null };
  }

  throw new UnsupportedDocumentError(extension);
}
