import { readFile } from "node:fs/promises";
import { PDFParse } from "pdf-parse";

const [path] = process.argv.slice(2);
if (!path) throw new Error("missing PDF path");

const parser = new PDFParse({ data: await readFile(path) });
try {
  const result = await parser.getText();
  process.stdout.write(JSON.stringify({ text: result.text, pages: result.total }));
} finally {
  await parser.destroy();
}
