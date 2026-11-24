import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
export const pdfStorageDir = path.join(DATA_DIR, 'pdfs');
export const uploadsStorageDir = path.join(DATA_DIR, 'uploads');

export function initializeLocalStorage(): void {
  for (const directory of [DATA_DIR, pdfStorageDir, uploadsStorageDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }
}
