const { PDFDocument, rgb, degrees } = require("pdf-lib");

const WATERMARK_TEXT    = "SAKURA - Secure Archiving and Keeping of Unified Records for Administration";
const WATERMARK_OPACITY = 0.08;
const WATERMARK_COLOR   = rgb(0.745, 0.071, 0.224); 
const FONT_SIZE_BASE    = 14; 

/**
 * Tambahkan watermark teks diagonal berulang ke setiap halaman PDF.
 *
 * @param {Buffer} pdfBuffer   — Buffer PDF asli
 * @returns {Promise<Buffer>}  — Buffer PDF dengan watermark
 */
async function addWatermarkToPdf(pdfBuffer) {
  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const font   = await pdfDoc.embedFont("Helvetica-Bold");
  const pages  = pdfDoc.getPages();

  for (const page of pages) {
    const { width, height } = page.getSize();

    const fontSize = Math.max(10, Math.min(FONT_SIZE_BASE, width / 42));
    const textWidth = font.widthOfTextAtSize(WATERMARK_TEXT, fontSize);

    const stepX = textWidth * 0.9;
    const stepY = fontSize * 5;

    const startX = -stepX;
    const startY = -stepY * 2;

    for (let y = startY; y < height + stepY * 2; y += stepY) {
      for (let x = startX; x < width + stepX; x += stepX) {
        page.drawText(WATERMARK_TEXT, {
          x,
          y,
          size:     fontSize,
          font,
          color:    WATERMARK_COLOR,
          opacity:  WATERMARK_OPACITY,
          rotate:   degrees(-25),
        });
      }
    }
  }

  const outputBytes = await pdfDoc.save();
  return Buffer.from(outputBytes);
}

module.exports = { addWatermarkToPdf };