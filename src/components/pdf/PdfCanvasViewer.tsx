import { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
// Bundle worker module on globalThis.pdfjsWorker so PDF.js renders cleanly without spawning external/blob Web Workers (CSP-safe)
import * as pdfjsWorker from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs';
import {
  ZoomIn,
  ZoomOut,
  RotateCw,
  AlertCircle,
  FileDown,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { downloadAuthenticatedFile, getApiUrl, getAuthToken } from '../../lib/api';

(globalThis as unknown as { pdfjsWorker?: unknown }).pdfjsWorker = pdfjsWorker;

type ZoomMode = 'fit-width' | 'fit-page' | 'manual';

interface PdfCanvasViewerProps {
  candidateId?: number;
  filename: string;
  refreshKey?: number;
  heightClassName?: string;
  customPdfBytes?: Uint8Array | null;
  customLoading?: boolean;
  onReloadCustom?: () => void;
}

export function PdfCanvasViewer({
  candidateId,
  filename,
  refreshKey = 0,
  heightClassName = 'h-[760px]',
  customPdfBytes,
  customLoading = false,
  onReloadCustom,
}: PdfCanvasViewerProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const pagesRef = useRef<HTMLDivElement | null>(null);

  const [zoomMode, setZoomMode] = useState<ZoomMode>('fit-width');
  const [manualScale, setManualScale] = useState(1.0);
  const [containerSize, setContainerSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [effectiveScale, setEffectiveScale] = useState(1.0);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const [numPages, setNumPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [internalReload, setInternalReload] = useState(0);

  // Close fullscreen cleanly with Escape key
  useEffect(() => {
    if (!isFullscreen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsFullscreen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isFullscreen]);

  // Measure viewport dimensions continuously for Fit-to-Width & Fit-to-Page modes
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const updateSize = () => {
      const usableW = Math.max(260, el.clientWidth - 48);
      const usableH = Math.max(320, el.clientHeight - 48);
      setContainerSize((prev) =>
        prev.width === usableW && prev.height === usableH ? prev : { width: usableW, height: usableH }
      );
    };
    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isFullscreen]);

  // Fetch authentic PDF bytes from backend API unless customPdfBytes are supplied directly
  useEffect(() => {
    if (customPdfBytes !== undefined) {
      setPdfBytes(customPdfBytes);
      setError(null);
      if (!customPdfBytes) {
        setLoading(customLoading);
      }
      return;
    }
    if (!candidateId) return;

    let cancelled = false;
    async function fetchPdf() {
      setLoading(true);
      setError(null);
      try {
        const token = getAuthToken();
        const res = await fetch(
          `${getApiUrl(`/api/candidates/${candidateId}/pdf`)}?inline=1&refresh=1&v=${refreshKey}-${internalReload}`,
          {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          }
        );
        if (!res.ok) {
          throw new Error(`Unable to load PDF (HTTP ${res.status})`);
        }
        const buf = await res.arrayBuffer();
        if (!cancelled) {
          setPdfBytes(new Uint8Array(buf));
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load PDF preview.');
          setLoading(false);
        }
      }
    }
    void fetchPdf();
    return () => {
      cancelled = true;
    };
  }, [candidateId, refreshKey, internalReload, customPdfBytes, customLoading]);

  // Re-render PDF pages on exact devicePixelRatio-aligned canvases + selectable TextLayer whenever zoom/bytes/layout changes
  useEffect(() => {
    if (!pdfBytes || !pagesRef.current) return;
    let cancelled = false;
    const activeRenderTasks: Array<{ cancel?: () => void }> = [];

    async function renderPages() {
      setLoading(true);
      setError(null);
      try {
        const loadingTask = pdfjsLib.getDocument({
          data: pdfBytes!.slice(),
          standardFontDataUrl: '/standard_fonts/',
          useSystemFonts: false,
        });
        const pdf = await loadingTask.promise;
        if (cancelled || !pagesRef.current) return;

        setNumPages(pdf.numPages);
        const container = pagesRef.current;
        container.innerHTML = '';

        // Exact physical screen pixel ratio ensures zero CSS scaling blur on crisp vector fonts
        const outputScale = window.devicePixelRatio || 1;

        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
          const page = await pdf.getPage(pageNum);
          if (cancelled) return;

          const baseViewport = page.getViewport({ scale: 1 });
          let computedScale = manualScale;

          if (zoomMode === 'fit-width' && containerSize.width > 0) {
            computedScale = Number(
              Math.min(1.8, Math.max(0.5, containerSize.width / baseViewport.width)).toFixed(3)
            );
          } else if (zoomMode === 'fit-page' && containerSize.width > 0 && containerSize.height > 0) {
            const scaleW = containerSize.width / baseViewport.width;
            const scaleH = containerSize.height / baseViewport.height;
            computedScale = Number(Math.min(1.8, Math.max(0.45, Math.min(scaleW, scaleH))).toFixed(3));
          }

          if (pageNum === 1) {
            setEffectiveScale(computedScale);
          }

          const viewport = page.getViewport({ scale: computedScale });
          const pixelWidth = Math.floor(viewport.width * outputScale);
          const pixelHeight = Math.floor(viewport.height * outputScale);
          const cssWidth = pixelWidth / outputScale;
          const cssHeight = pixelHeight / outputScale;

          // Wrapper holding exact-pixel canvas + aligned selectable PDF.js TextLayer
          const pageWrapper = document.createElement('div');
          pageWrapper.className = 'relative mx-auto bg-white shadow-md border border-slate-300 rounded-sm shrink-0';
          pageWrapper.style.width = `${cssWidth}px`;
          pageWrapper.style.height = `${cssHeight}px`;
          pageWrapper.style.setProperty('--total-scale-factor', String(viewport.scale));
          pageWrapper.style.setProperty('--scale-round-x', '1px');
          pageWrapper.style.setProperty('--scale-round-y', '1px');

          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d', { alpha: false });
          if (!context) continue;

          canvas.width = pixelWidth;
          canvas.height = pixelHeight;
          canvas.style.width = `${cssWidth}px`;
          canvas.style.height = `${cssHeight}px`;
          canvas.className = 'block';

          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, canvas.width, canvas.height);

          const textLayerDiv = document.createElement('div');
          textLayerDiv.className = 'textLayer';

          pageWrapper.appendChild(canvas);
          pageWrapper.appendChild(textLayerDiv);

          if (!cancelled && pagesRef.current) {
            pagesRef.current.appendChild(pageWrapper);
          }

          const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;
          const renderTask = page.render({ canvasContext: context, viewport, transform, canvas });
          activeRenderTasks.push(renderTask);
          await renderTask.promise;

          if (cancelled) return;

          // Mount selectable text layer over the canvas
          const textLayer = new pdfjsLib.TextLayer({
            textContentSource: page.streamTextContent(),
            container: textLayerDiv,
            viewport,
          });
          activeRenderTasks.push(textLayer);
          await textLayer.render();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!cancelled && !/cancel/i.test(msg)) {
          setError(msg || 'Unable to render PDF document.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void renderPages();
    return () => {
      cancelled = true;
      for (const task of activeRenderTasks) {
        try {
          task.cancel?.();
        } catch {
          // ignore cancelled render tasks
        }
      }
    };
  }, [pdfBytes, zoomMode, manualScale, containerSize]);

  const currentPct = Math.round((zoomMode === 'manual' ? manualScale : effectiveScale) * 100);

  return (
    <div
      className={
        isFullscreen
          ? 'fixed inset-0 z-50 flex flex-col bg-[#0F172A]'
          : `flex flex-col bg-[#EEF1F5] ${heightClassName}`
      }
    >
      {/* Viewer Toolbar */}
      <div className="px-4 py-2 bg-white border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs shrink-0">
        <div className="flex items-center gap-2 text-slate-600 tabular-nums">
          <span className="font-medium text-[#10243A]">
            {numPages > 0 ? `${numPages} Page${numPages > 1 ? 's' : ''}` : 'A4 (210 × 297 mm)'}
          </span>
          <span aria-hidden="true">·</span>
          <span className="font-mono text-[11px]">{currentPct}%</span>
          {isFullscreen && (
            <>
              <span aria-hidden="true">·</span>
              <span className="font-mono text-[11px] text-slate-500 truncate max-w-[220px]">{filename}</span>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={() => {
              const base = zoomMode === 'manual' ? manualScale : effectiveScale;
              setZoomMode('manual');
              setManualScale(Math.max(0.45, Number((base - 0.15).toFixed(2))));
            }}
            title="Zoom Out"
            className="p-1.5 text-slate-600 hover:text-[#10243A] hover:bg-slate-100 rounded"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              const base = zoomMode === 'manual' ? manualScale : effectiveScale;
              setZoomMode('manual');
              setManualScale(Math.min(4.17, Number((base + 0.15).toFixed(2))));
            }}
            title="Zoom In (up to 300+ DPI)"
            className="p-1.5 text-slate-600 hover:text-[#10243A] hover:bg-slate-100 rounded"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>

          <span className="w-px h-4 bg-slate-200 mx-0.5" aria-hidden="true" />

          <button
            type="button"
            onClick={() => {
              setZoomMode('manual');
              setManualScale(1.0);
            }}
            className={`px-2 py-1 text-[11px] font-medium rounded ${
              zoomMode === 'manual' && Math.abs(manualScale - 1.0) < 0.01
                ? 'bg-slate-100 text-[#10243A]'
                : 'text-slate-600 hover:text-[#10243A] hover:bg-slate-100'
            }`}
          >
            100%
          </button>
          <button
            type="button"
            onClick={() => setZoomMode('fit-width')}
            className={`px-2 py-1 text-[11px] font-medium rounded ${
              zoomMode === 'fit-width'
                ? 'bg-slate-100 text-[#10243A]'
                : 'text-slate-600 hover:text-[#10243A] hover:bg-slate-100'
            }`}
          >
            Fit Width
          </button>
          <button
            type="button"
            onClick={() => setZoomMode('fit-page')}
            className={`px-2 py-1 text-[11px] font-medium rounded ${
              zoomMode === 'fit-page'
                ? 'bg-slate-100 text-[#10243A]'
                : 'text-slate-600 hover:text-[#10243A] hover:bg-slate-100'
            }`}
          >
            Fit Page
          </button>

          <span className="w-px h-4 bg-slate-200 mx-0.5" aria-hidden="true" />

          <button
            type="button"
            onClick={() => {
              if (onReloadCustom) {
                onReloadCustom();
              } else {
                setInternalReload((n) => n + 1);
              }
            }}
            title="Regenerate & Reload PDF"
            className="p-1.5 text-slate-600 hover:text-[#10243A] hover:bg-slate-100 rounded"
          >
            <RotateCw className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setIsFullscreen((prev) => !prev)}
            title={isFullscreen ? 'Exit Full-Screen Preview' : 'Full-Screen Preview'}
            className="p-1.5 text-slate-600 hover:text-[#10243A] hover:bg-slate-100 rounded"
          >
            {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => {
              if (customPdfBytes) {
                const blob = new Blob([customPdfBytes.slice()], { type: 'application/pdf' });
                const blobUrl = URL.createObjectURL(blob);
                const anchor = document.createElement('a');
                anchor.href = blobUrl;
                anchor.download = filename;
                document.body.appendChild(anchor);
                anchor.click();
                anchor.remove();
                setTimeout(() => URL.revokeObjectURL(blobUrl), 1500);
              } else if (candidateId) {
                void downloadAuthenticatedFile(`/api/candidates/${candidateId}/pdf?download=1`, filename);
              }
            }}
            className="inline-flex items-center gap-1 ml-1 px-2.5 py-1 text-[11px] font-semibold text-[#2563EB] bg-blue-50 hover:bg-blue-100 rounded"
          >
            <FileDown className="w-3.5 h-3.5" />
            <span>Download</span>
          </button>
        </div>
      </div>

      {/* Scrollable Canvas Viewport */}
      <div
        ref={viewportRef}
        className={`flex-1 overflow-auto scroll-smooth p-5 relative ${isFullscreen ? 'bg-[#1E293B]' : ''}`}
      >
        {(loading || customLoading) && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#EEF1F5]/80 z-10 text-xs font-medium text-slate-600">
            Rendering Offer Letter PDF...
          </div>
        )}

        {error ? (
          <div className="max-w-md mx-auto mt-12 bg-white border border-red-200 rounded-xl p-5 text-xs text-[#DC4545] flex items-start gap-2.5">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold">Unable to display PDF preview</div>
              <div className="mt-1 text-slate-600">{error}</div>
            </div>
          </div>
        ) : (
          <div ref={pagesRef} className="space-y-4 w-max min-w-full flex flex-col items-center" />
        )}
      </div>
    </div>
  );
}
