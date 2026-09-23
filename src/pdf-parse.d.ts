/**
 * Type declarations for pdf-parse (CJS module without bundled types)
 */
declare module "pdf-parse" {
  interface PdfData {
    /** Extracted text content from all pages */
    text: string;
    /** Number of pages in the PDF */
    numpages: number;
    /** Number of pages that were rendered */
    numrender: number;
    /** PDF metadata (title, author, etc.) */
    info: Record<string, unknown>;
    /** PDF metadata (raw) */
    metadata: unknown;
    /** PDF version */
    version: string;
  }

  /**
   * Parse a PDF buffer and extract text content.
   * @param dataBuffer - The PDF file as a Buffer
   * @param options - Optional parsing configuration
   * @returns Parsed PDF data including text and metadata
   */
  function pdfParse(
    dataBuffer: Buffer,
    options?: Record<string, unknown>
  ): Promise<PdfData>;

  export default pdfParse;
}
