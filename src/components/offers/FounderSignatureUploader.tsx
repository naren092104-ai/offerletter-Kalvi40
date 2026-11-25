import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, PenTool, RotateCcw, Save, Trash2, Upload, X } from 'lucide-react';
import { apiRequest } from '../../lib/api';
import { useToast } from '../ui/Toast';
import type { FounderSignatureInfo } from '../../types/kalvi40';

interface FounderSignatureUploaderProps {
  compact?: boolean;
  onUpdated?: (sig: FounderSignatureInfo) => void;
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode the selected image file.'));
    img.src = src;
  });
}

async function processSignatureImage(
  sourceDataUrl: string,
  removeWhiteBg: boolean
): Promise<{ processedDataUrl: string; hadAlpha: boolean }> {
  const img = await loadImageElement(sourceDataUrl);
  const maxDim = 1600;
  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
  const w = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
  const h = Math.max(1, Math.round((img.naturalHeight || 1) * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Browser canvas is unavailable.');

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);

  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;

  let hadAlpha = false;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 245) {
      hadAlpha = true;
      break;
    }
  }

  if (removeWhiteBg) {
    // Convert near-white paper pixels to smooth transparent alpha while preserving ink strokes
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (a === 0) continue;

      const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
      const minChannel = Math.min(r, g, b);
      const maxChannel = Math.max(r, g, b);
      const saturation = maxChannel - minChannel;

      if (luminance > 228 && saturation < 38) {
        data[i + 3] = 0;
      } else if (luminance > 196 && saturation < 48) {
        // Smooth edge feathering so strokes remain crisp and anti-aliased
        const factor = Math.max(0, Math.min(1, (228 - luminance) / 32));
        data[i + 3] = Math.round(a * factor);
      }
    }
    ctx.putImageData(imageData, 0, 0);
  }

  // Auto-trim transparent outer padding so signature aligns cleanly with the left margin
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  const checkData = ctx.getImageData(0, 0, w, h).data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      if (checkData[idx + 3] > 16) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX >= minX && maxY >= minY && (hadAlpha || removeWhiteBg)) {
    const pad = 6;
    const cropX = Math.max(0, minX - pad);
    const cropY = Math.max(0, minY - pad);
    const cropW = Math.min(w - cropX, maxX - minX + 1 + pad * 2);
    const cropH = Math.min(h - cropY, maxY - minY + 1 + pad * 2);

    const trimmed = document.createElement('canvas');
    trimmed.width = cropW;
    trimmed.height = cropH;
    const tCtx = trimmed.getContext('2d');
    if (tCtx) {
      tCtx.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
      return { processedDataUrl: trimmed.toDataURL('image/png'), hadAlpha };
    }
  }

  return { processedDataUrl: canvas.toDataURL('image/png'), hadAlpha };
}

export function FounderSignatureUploader({ compact = false, onUpdated }: FounderSignatureUploaderProps) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [signature, setSignature] = useState<FounderSignatureInfo>({
    hasCustomSignature: false,
    heightPt: 40,
    updatedAt: null,
    dataUrl: null,
  });

  const [rawSelectedDataUrl, setRawSelectedDataUrl] = useState<string | null>(null);
  const [selectedFileName, setSelectedFileName] = useState('');
  const [removeWhiteBg, setRemoveWhiteBg] = useState(true);
  const [processedPreviewUrl, setProcessedPreviewUrl] = useState<string | null>(null);
  const [heightPt, setHeightPt] = useState(40);
  const [processing, setProcessing] = useState(false);

  async function fetchSignature() {
    setLoading(true);
    try {
      const res = await apiRequest<{ signature: FounderSignatureInfo }>('/api/settings/signature');
      setSignature(res.signature);
      setHeightPt(res.signature.heightPt || 40);
    } catch (err) {
      toast({
        title: 'Unable to load Founder signature',
        description: err instanceof Error ? err.message : 'Error',
        variant: 'error',
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchSignature();
  }, []);

  useEffect(() => {
    if (!rawSelectedDataUrl) {
      setProcessedPreviewUrl(null);
      return;
    }
    let cancelled = false;
    setProcessing(true);
    void processSignatureImage(rawSelectedDataUrl, removeWhiteBg)
      .then(({ processedDataUrl }) => {
        if (!cancelled) setProcessedPreviewUrl(processedDataUrl);
      })
      .catch((err) => {
        if (!cancelled) {
          toast({
            title: 'Image processing failed',
            description: err instanceof Error ? err.message : 'Invalid image file.',
            variant: 'error',
          });
          setRawSelectedDataUrl(null);
          setSelectedFileName('');
        }
      })
      .finally(() => {
        if (!cancelled) setProcessing(false);
      });

    return () => {
      cancelled = true;
    };
  }, [rawSelectedDataUrl, removeWhiteBg]);

  function handleFileChosen(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast({
        title: 'Unsupported file type',
        description: 'Please upload a PNG, JPG, JPEG, or WebP signature image.',
        variant: 'warning',
      });
      return;
    }
    if (file.size > 6 * 1024 * 1024) {
      toast({
        title: 'File too large',
        description: 'Please choose a signature image under 6 MB.',
        variant: 'warning',
      });
      return;
    }

    const reader = new FileReader();
    reader.onload = async () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      if (!result) return;
      setSelectedFileName(file.name);
      // Detect existing transparency to pick the smartest default for removeWhiteBg
      try {
        const probe = await processSignatureImage(result, false);
        setRemoveWhiteBg(!probe.hadAlpha);
      } catch {
        setRemoveWhiteBg(true);
      }
      setRawSelectedDataUrl(result);
    };
    reader.readAsDataURL(file);
  }

  async function handleUploadSave() {
    if (!processedPreviewUrl) return;
    setSaving(true);
    try {
      const res = await apiRequest<{ signature: FounderSignatureInfo }>('/api/settings/signature', {
        method: 'POST',
        body: JSON.stringify({
          imageDataUrl: processedPreviewUrl,
          heightPt,
        }),
      });
      setSignature(res.signature);
      setRawSelectedDataUrl(null);
      setProcessedPreviewUrl(null);
      setSelectedFileName('');
      if (fileInputRef.current) fileInputRef.current.value = '';
      toast({
        title: 'Founder Signature Saved',
        description: 'All offer letter PDFs will now display your uploaded Founder signature.',
        variant: 'success',
      });
      onUpdated?.(res.signature);
    } catch (err) {
      toast({
        title: 'Signature upload failed',
        description: err instanceof Error ? err.message : 'Unable to save signature.',
        variant: 'error',
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveSizeOnly() {
    setSaving(true);
    try {
      const res = await apiRequest<{ signature: FounderSignatureInfo }>('/api/settings/signature/options', {
        method: 'PUT',
        body: JSON.stringify({ heightPt }),
      });
      setSignature(res.signature);
      toast({
        title: 'Signature Size Updated',
        description: `PDF signature height updated to ${res.signature.heightPt} pt.`,
        variant: 'success',
      });
      onUpdated?.(res.signature);
    } catch (err) {
      toast({
        title: 'Unable to update size',
        description: err instanceof Error ? err.message : 'Error',
        variant: 'error',
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleResetDefault() {
    setSaving(true);
    try {
      const res = await apiRequest<{ signature: FounderSignatureInfo }>('/api/settings/signature', {
        method: 'DELETE',
      });
      setSignature(res.signature);
      setRawSelectedDataUrl(null);
      setProcessedPreviewUrl(null);
      setSelectedFileName('');
      if (fileInputRef.current) fileInputRef.current.value = '';
      toast({
        title: 'Default Signature Restored',
        description: 'Uploaded signature removed. Offer PDFs reverted to the default signature.',
        variant: 'success',
      });
      onUpdated?.(res.signature);
    } catch (err) {
      toast({
        title: 'Unable to remove signature',
        description: err instanceof Error ? err.message : 'Error',
        variant: 'error',
      });
    } finally {
      setSaving(false);
    }
  }

  const activePreviewSrc = processedPreviewUrl || signature.dataUrl;
  const hasPendingUpload = Boolean(processedPreviewUrl);
  const sizeDirty = signature.hasCustomSignature && !hasPendingUpload && heightPt !== signature.heightPt;

  if (loading) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-5 text-xs text-slate-500">
        Loading Founder signature settings...
      </div>
    );
  }

  return (
    <div className={compact ? 'space-y-4' : 'bg-white border border-slate-200 rounded-xl p-6 space-y-5'}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <PenTool className="w-4 h-4 text-[#2563EB] mt-0.5 shrink-0" />
          <div>
            <h3 className="text-sm font-semibold text-[#10243A]">Founder &amp; Managing Trustee Signature</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Upload a high-resolution PNG or JPG signature image. It embeds crisply above &ldquo;Founder &amp; Managing Trustee&rdquo; in every offer letter PDF.
            </p>
          </div>
        </div>
        {signature.hasCustomSignature && (
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-[#16A36A]">
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>Custom Signature Active</span>
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-stretch">
        {/* Upload Dropzone */}
        <div className="border border-slate-200 rounded-xl p-4 bg-[#F7F8FA] flex flex-col justify-between gap-3">
          <label
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              handleFileChosen(e.dataTransfer.files?.[0]);
            }}
            className="flex-1 border-2 border-dashed border-slate-300 hover:border-[#2563EB] rounded-lg p-5 bg-white cursor-pointer flex flex-col items-center justify-center text-center transition-colors"
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/*"
              className="hidden"
              onChange={(e) => handleFileChosen(e.target.files?.[0])}
            />
            <Upload className="w-6 h-6 text-[#2563EB] mb-2" />
            <div className="text-xs font-semibold text-[#10243A]">
              {selectedFileName ? `Selected: ${selectedFileName}` : 'Click or drop Founder signature image'}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">PNG (transparent), JPG, or WebP · Max 5 MB</div>
          </label>

          {rawSelectedDataUrl && (
            <label className="inline-flex items-center gap-2 text-xs text-[#10243A] cursor-pointer">
              <input
                type="checkbox"
                checked={removeWhiteBg}
                onChange={(e) => setRemoveWhiteBg(e.target.checked)}
              />
              <span>Auto-remove white paper background &amp; trim margins</span>
            </label>
          )}

          {/* Height Slider */}
          <div className="space-y-1.5 pt-1">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-[#10243A]">PDF Signature Height</span>
              <span className="font-mono text-slate-600 tabular-nums">{heightPt} pt</span>
            </div>
            <input
              type="range"
              min={24}
              max={72}
              step={2}
              value={heightPt}
              onChange={(e) => setHeightPt(Number(e.target.value))}
              className="w-full accent-[#2563EB]"
            />
          </div>
        </div>

        {/* Live Offer Letter Signature Block Preview */}
        <div className="border border-slate-200 rounded-xl p-5 bg-white flex flex-col justify-between">
          <div className="text-[11px] font-semibold text-slate-500 mb-3">
            {hasPendingUpload ? 'New Signature Preview (Unsaved)' : 'Live PDF Signature Block Preview'}
          </div>

          <div
            className="border border-slate-100 rounded-lg p-4 bg-white space-y-1 text-[#10243A]"
            style={{ fontFamily: '"Times New Roman", Times, Georgia, serif' }}
          >
            <div className="text-[13px]">With regards,</div>
            <div className="py-1.5 min-h-[54px] flex items-center">
              {processing ? (
                <span className="text-xs font-sans text-slate-400">Processing crisp signature...</span>
              ) : activePreviewSrc ? (
                <img
                  src={activePreviewSrc}
                  alt="Founder Signature"
                  style={{ height: `${Math.round(heightPt * 1.2)}px`, maxWidth: '220px' }}
                  className="object-contain object-left select-none"
                />
              ) : (
                <svg width="110" height="42" viewBox="0 0 92 38" fill="none" className="text-[#2E3D5C]">
                  <path
                    d="M 2 18 C 8 6, 13 2, 11 10 C 9 18, 4 21, 10 19 C 16 17, 24 12, 26 8 C 28 4, 24 14, 27 17 C 30 20, 35 14, 41 11 C 46 8, 50 18, 55 15 C 60 12, 66 2, 69 1 C 72 0, 61 28, 56 32 C 51 36, 46 28, 58 21 C 68 15, 78 13, 88 13"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </div>
            <div className="text-[13px]">Founder &amp; Managing Trustee</div>
            <div className="text-[13px]">BumbleB Trust, Chennai</div>
          </div>

          <div className="text-[11px] text-slate-500 mt-3">
            {hasPendingUpload
              ? 'Click "Upload & Apply Signature" to embed this signature in all generated offer letters.'
              : signature.hasCustomSignature
              ? 'This uploaded image is embedded at original sharp resolution in every generated PDF.'
              : 'Currently using the built-in default signature. Upload a PNG/JPG above to replace it.'}
          </div>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 pt-2 border-t border-slate-200">
        <div>
          {signature.hasCustomSignature && (
            <button
              type="button"
              disabled={saving}
              onClick={handleResetDefault}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#DC4545] bg-white border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Remove &amp; Reset to Default</span>
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          {hasPendingUpload && (
            <button
              type="button"
              onClick={() => {
                setRawSelectedDataUrl(null);
                setProcessedPreviewUrl(null);
                setSelectedFileName('');
                if (fileInputRef.current) fileInputRef.current.value = '';
              }}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Cancel Selection</span>
            </button>
          )}

          {sizeDirty && (
            <button
              type="button"
              disabled={saving}
              onClick={handleSaveSizeOnly}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-[#10243A] hover:bg-slate-800 rounded-lg disabled:opacity-50"
            >
              <Save className="w-3.5 h-3.5" />
              <span>{saving ? 'Updating...' : 'Save Signature Size'}</span>
            </button>
          )}

          {hasPendingUpload && (
            <button
              type="button"
              disabled={saving || processing}
              onClick={handleUploadSave}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#2563EB] hover:bg-blue-700 rounded-lg disabled:opacity-50"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>{saving ? 'Uploading...' : 'Upload & Apply Signature'}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface FounderSignatureModalProps {
  open: boolean;
  onClose: () => void;
  onUpdated?: (sig: FounderSignatureInfo) => void;
}

export function FounderSignatureModal({ open, onClose, onUpdated }: FounderSignatureModalProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/55 p-4">
      <div className="bg-white border border-slate-200 rounded-xl shadow-2xl max-w-3xl w-full max-h-[90vh] flex flex-col overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <PenTool className="w-4 h-4 text-[#2563EB]" />
            <h3 className="text-base font-semibold text-[#10243A]">Upload Founder Signature</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg"
            aria-label="Close signature modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto">
          <FounderSignatureUploader
            compact
            onUpdated={(sig) => {
              onUpdated?.(sig);
            }}
          />
        </div>
      </div>
    </div>
  );
}
