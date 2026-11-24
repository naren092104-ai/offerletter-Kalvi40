/// <reference types="vite/client" />

declare module 'pdfjs-dist/legacy/build/pdf.worker.min.mjs' {
  const WorkerMessageHandler: unknown;
  export { WorkerMessageHandler };
}
