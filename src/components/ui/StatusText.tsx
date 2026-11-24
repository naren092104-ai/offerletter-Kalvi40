import { CheckCircle2, Clock, Loader2, XCircle, FileCheck2, FileWarning } from 'lucide-react';

export function DeliveryStatusText({ status }: { status: string | null | undefined }) {
  const s = (status || 'not_sent').toLowerCase();

  if (s === 'sent' || s === 'delivered') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#16A36A] whitespace-nowrap">
        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
        <span>{s === 'delivered' ? 'Delivered' : 'Sent'}</span>
      </span>
    );
  }
  if (s === 'accepted') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#2563EB] whitespace-nowrap">
        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
        <span>Provider Accepted</span>
      </span>
    );
  }
  if (s === 'processing') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#2563EB] whitespace-nowrap">
        <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" />
        <span>Processing</span>
      </span>
    );
  }
  if (s === 'pending' || s === 'queued') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#D97706] whitespace-nowrap">
        <Clock className="w-3.5 h-3.5 shrink-0" />
        <span>Pending</span>
      </span>
    );
  }
  if (s === 'failed' || s === 'bounced') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#DC4545] whitespace-nowrap">
        <XCircle className="w-3.5 h-3.5 shrink-0" />
        <span>{s === 'bounced' ? 'Bounced' : 'Failed'}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 whitespace-nowrap">
      <Clock className="w-3.5 h-3.5 shrink-0" />
      <span>Not Sent</span>
    </span>
  );
}

export function PdfStatusText({ generated }: { generated: number | boolean }) {
  if (generated) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#16A36A] whitespace-nowrap">
        <FileCheck2 className="w-3.5 h-3.5 shrink-0" />
        <span>PDF Ready</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 whitespace-nowrap">
      <FileWarning className="w-3.5 h-3.5 shrink-0" />
      <span>Pending PDF</span>
    </span>
  );
}
