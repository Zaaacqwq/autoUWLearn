import assert from "node:assert/strict";
import test from "node:test";
import { extractDocumentText, UnsupportedDocumentError } from "./extractText.js";

// A minimal one-page PDF whose only content is the string "Hello PDF".
const HELLO_PDF_BASE64 =
  "JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCAyMDAgMjAwXS9SZXNvdXJjZXM8PC9Gb250PDwvRjEgNCAwIFI+Pj4+L0NvbnRlbnRzIDUgMCBSPj4KZW5kb2JqCjQgMCBvYmoKPDwvVHlwZS9Gb250L1N1YnR5cGUvVHlwZTEvQmFzZUZvbnQvSGVsdmV0aWNhPj4KZW5kb2JqCjUgMCBvYmoKPDwvTGVuZ3RoIDQ0Pj4Kc3RyZWFtCkJUCi9GMSAyNCBUZgoyMCAxMDAgVGQKKEhlbGxvIFBERikgVGoKRVQKZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1NiAwMDAwMCBuIAowMDAwMDAwMTExIDAwMDAwIG4gCjAwMDAwMDAyMzUgMDAwMDAgbiAKMDAwMDAwMDMwNCAwMDAwMCBuIAp0cmFpbGVyCjw8L1NpemUgNi9Sb290IDEgMCBSPj4Kc3RhcnR4cmVmCjM5OAolJUVPRgo=";

const pdfBytes = () => new Uint8Array(Buffer.from(HELLO_PDF_BASE64, "base64"));
const bytesOf = (text: string) => new Uint8Array(Buffer.from(text, "utf8"));

test("extracts text and page count from a PDF", async () => {
  const result = await extractDocumentText(pdfBytes(), "application/pdf", "slides.pdf");
  assert.match(result.text, /Hello PDF/);
  assert.equal(result.pages, 1);
});

test("recognises a PDF by extension when the content type is generic", async () => {
  const result = await extractDocumentText(pdfBytes(), "application/octet-stream", "slides.pdf");
  assert.match(result.text, /Hello PDF/);
});

test("strips markup from HTML and keeps the readable text", async () => {
  const html = "<html><head><style>p{color:red}</style><script>var x=1;</script></head>" +
    "<body><h1>Week 1</h1><p>Read chapter&nbsp;2 &amp; 3.</p></body></html>";
  const result = await extractDocumentText(bytesOf(html), "text/html", "page.html");

  assert.match(result.text, /Week 1/);
  assert.match(result.text, /Read chapter 2 & 3\./);
  assert.doesNotMatch(result.text, /color:red|var x/, "style and script contents are not readable text");
  assert.equal(result.pages, null);
});

test("passes plain text through", async () => {
  const result = await extractDocumentText(bytesOf("line one\nline two"), "text/plain", "notes.txt");
  assert.equal(result.text, "line one\nline two");
});

test("rejects formats it cannot read, naming the format", async () => {
  await assert.rejects(
    () => extractDocumentText(bytesOf("PK"), "application/vnd.ms-powerpoint", "deck.pptx"),
    (error: unknown) => {
      assert.ok(error instanceof UnsupportedDocumentError);
      assert.match(error.message, /pptx/);
      return true;
    }
  );
});

test("collapses runaway whitespace so results stay compact", async () => {
  const result = await extractDocumentText(bytesOf("a\n\n\n\n\nb     c"), "text/plain", "n.txt");
  assert.equal(result.text, "a\n\nb c");
});

test("extracting a PDF twice from the same buffer works", async () => {
  // pdf.js transfers the buffer into its worker, detaching it. If the bytes are
  // not copied first, the caller's Uint8Array is destroyed by the first read.
  const bytes = pdfBytes();
  const originalLength = bytes.byteLength;

  const first = await extractDocumentText(bytes, "application/pdf", "a.pdf");
  assert.equal(bytes.byteLength, originalLength, "the caller's buffer must not be detached");

  const second = await extractDocumentText(bytes, "application/pdf", "a.pdf");
  assert.match(first.text, /Hello PDF/);
  assert.match(second.text, /Hello PDF/);
});
