import React, { useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import {
  Upload,
  FileSpreadsheet,
  CheckCircle2,
  AlertTriangle,
  Download,
  ArrowRight,
  ArrowLeft,
  RotateCcw,
} from 'lucide-react';
import { apiRequest } from '../lib/api';
import { useToast } from '../components/ui/Toast';
import { formatDateDDMMYYYY } from '../types/kalvi40';
import type { NavPageId } from '../components/layout/Sidebar';

interface BulkImportPageProps {
  onNavigate: (page: NavPageId) => void;
}

type TargetField = 'candidate_name' | 'school_name' | 'location' | 'district' | 'phone' | 'email' | 'joining_date';

const TARGET_FIELDS: Array<{ key: TargetField; label: string; aliases: string[] }> = [
  { key: 'candidate_name', label: 'Candidate Name', aliases: ['candidate name', 'name', 'candidate', 'full name'] },
  {
    key: 'school_name',
    label: 'School Name',
    aliases: ['school name', 'school', 'schools', 'school names', 'institution', 'school/college', 'center', 'centre'],
  },
  { key: 'location', label: 'Location', aliases: ['location', 'village', 'town', 'city', 'place', 'address'] },
  { key: 'district', label: 'District', aliases: ['district', 'dist'] },
  { key: 'phone', label: 'Mobile Number', aliases: ['phone', 'phone number', 'mobile', 'mobile number', 'contact', 'telephone'] },
  { key: 'email', label: 'Email', aliases: ['email', 'email address', 'email id', 'mail'] },
  { key: 'joining_date', label: 'Joining Date', aliases: ['joining date', 'join date', 'date', 'start date', 'doj'] },
];

interface ParsedRow {
  rowNumber: number;
  candidate_name: string;
  school_name: string;
  location: string;
  district: string;
  phone: string;
  email: string;
  joining_date: string;
  errors: string[];
  isDuplicateInFile: boolean;
  isDuplicateInDb: boolean;
  isValid: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function BulkImportPage({ onNavigate }: BulkImportPageProps) {
  const { toast } = useToast();
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [fileName, setFileName] = useState('');
  const [rawHeaders, setRawHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<Array<Record<string, unknown>>>([]);
  const [columnMap, setColumnMap] = useState<Record<TargetField, string>>({
    candidate_name: '',
    school_name: '',
    location: '',
    district: '',
    phone: '',
    email: '',
    joining_date: '',
  });
  const [validatedRows, setValidatedRows] = useState<ParsedRow[]>([]);
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ importedCount: number; skippedCount: number } | null>(null);
  const [existingDbEmails, setExistingDbEmails] = useState<Set<string>>(new Set());

  function normalizeExcelCell(val: unknown): string {
    if (val === null || val === undefined) return '';
    if (val instanceof Date && !Number.isNaN(val.getTime())) {
      const d = String(val.getDate()).padStart(2, '0');
      const m = String(val.getMonth() + 1).padStart(2, '0');
      return `${d}.${m}.${val.getFullYear()}`;
    }
    return String(val).trim();
  }

  function downloadSampleTemplate() {
    const rows = [
      {
        'Candidate Name': 'Sample Candidate One',
        'School Name': 'Sample Government Middle School',
        Location: 'Sample Town',
        District: 'Tiruvannamalai',
        'Mobile Number': '9000000001',
        Email: 'candidate1@example.org',
        'Joining Date': '21.10.2026',
      },
      {
        'Candidate Name': 'Sample Candidate Two',
        'School Name': 'Sample Girls Higher Secondary School',
        Location: 'Sample City',
        District: 'Chengalpattu',
        'Mobile Number': '9000000002',
        Email: 'candidate2@example.org',
        'Joining Date': '01.11.2026',
      },
      {
        'Candidate Name': 'Sample Candidate Three',
        'School Name': 'Sample Panchayat Union Middle School',
        Location: 'Sample Village',
        District: 'Villupuram',
        'Mobile Number': '9000000003',
        Email: 'candidate3@example.org',
        'Joining Date': '02.11.2026',
      },
    ];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Candidates');
    XLSX.writeFile(workbook, 'Kalvi40_Candidate_Import_Template_With_Mobile.xlsx');
  }

  async function handleFileSelect(file: File) {
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
      const firstSheetName = workbook.SheetNames[0];
      if (!firstSheetName) {
        toast({ title: 'Empty workbook', description: 'The uploaded file has no sheets.', variant: 'error' });
        return;
      }

      const sheet = workbook.Sheets[firstSheetName];
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
      if (rows.length === 0) {
        toast({ title: 'No rows found', description: 'Upload a sheet containing at least one candidate row.', variant: 'error' });
        return;
      }

      const headers = Object.keys(rows[0]);
      const autoMap: Record<TargetField, string> = {
        candidate_name: '',
        school_name: '',
        location: '',
        district: '',
        phone: '',
        email: '',
        joining_date: '',
      };

      for (const tf of TARGET_FIELDS) {
        const matched = headers.find((h) => {
          const norm = h.toLowerCase().replace(/[_-]+/g, ' ').trim();
          return tf.aliases.some((alias) => norm === alias || norm.includes(alias));
        });
        if (matched) autoMap[tf.key] = matched;
      }

      // Fetch existing DB emails to flag duplicates accurately
      const dbRes = await apiRequest<{ items: Array<{ email: string }> }>('/api/candidates?all=true');
      setExistingDbEmails(new Set(dbRes.items.map((c) => c.email.trim().toLowerCase())));

      setFileName(file.name);
      setRawHeaders(headers);
      setRawRows(rows);
      setColumnMap(autoMap);
      setStep(2);
    } catch (err) {
      toast({
        title: 'Failed to parse file',
        description: err instanceof Error ? err.message : 'Ensure the file is a valid .xlsx or .csv file.',
        variant: 'error',
      });
    }
  }

  function revalidateRows(rowsToCheck: ParsedRow[]): ParsedRow[] {
    const seenEmails = new Map<string, number>();
    for (const r of rowsToCheck) {
      const em = r.email.trim().toLowerCase();
      if (em) seenEmails.set(em, (seenEmails.get(em) || 0) + 1);
    }

    return rowsToCheck.map((r) => {
      const errors: string[] = [];
      if (!r.candidate_name.trim()) errors.push('Missing Candidate Name');
      if (!r.school_name.trim()) errors.push('Missing School Name');
      if (!r.location.trim()) errors.push('Missing Location');
      if (!r.district.trim()) errors.push('Missing District');
      if (!r.phone.trim()) errors.push('Missing Phone');
      if (!r.joining_date.trim()) errors.push('Missing Joining Date');

      const em = r.email.trim().toLowerCase();
      if (!em) {
        errors.push('Missing Email');
      } else if (!EMAIL_RE.test(em)) {
        errors.push('Invalid Email Format');
      }

      const isDuplicateInFile = Boolean(em && (seenEmails.get(em) || 0) > 1);
      const isDuplicateInDb = Boolean(em && existingDbEmails.has(em));
      if (isDuplicateInFile) errors.push('Duplicate Email in File');
      if (isDuplicateInDb) errors.push('Already Exists in Database');

      return {
        ...r,
        isDuplicateInFile,
        isDuplicateInDb,
        errors,
        isValid: errors.length === 0,
      };
    });
  }

  function runValidationStep() {
    const mapped: ParsedRow[] = rawRows.map((row, idx) => ({
      rowNumber: idx + 2,
      candidate_name: columnMap.candidate_name ? normalizeExcelCell(row[columnMap.candidate_name]) : '',
      school_name: columnMap.school_name ? normalizeExcelCell(row[columnMap.school_name]) : '',
      location: columnMap.location ? normalizeExcelCell(row[columnMap.location]) : '',
      district: columnMap.district ? normalizeExcelCell(row[columnMap.district]) : '',
      phone: columnMap.phone ? normalizeExcelCell(row[columnMap.phone]) : '',
      email: columnMap.email ? normalizeExcelCell(row[columnMap.email]).toLowerCase() : '',
      joining_date: columnMap.joining_date ? formatDateDDMMYYYY(normalizeExcelCell(row[columnMap.joining_date])) : '',
      errors: [],
      isDuplicateInFile: false,
      isDuplicateInDb: false,
      isValid: false,
    }));
    setValidatedRows(revalidateRows(mapped));
    setStep(3);
  }

  function updateCell(rowIndex: number, field: TargetField, value: string) {
    const next = validatedRows.map((r, idx) => (idx === rowIndex ? { ...r, [field]: value } : r));
    setValidatedRows(revalidateRows(next));
  }

  const summary = useMemo(() => {
    const total = validatedRows.length;
    const valid = validatedRows.filter((r) => r.isValid).length;
    const duplicates = validatedRows.filter((r) => r.isDuplicateInFile || r.isDuplicateInDb).length;
    const missing = validatedRows.filter((r) => r.errors.some((e) => e.startsWith('Missing'))).length;
    const invalid = total - valid;
    return { total, valid, invalid, duplicates, missing };
  }, [validatedRows]);

  function downloadErrorReport() {
    const invalidRows = validatedRows.filter((r) => !r.isValid);
    if (invalidRows.length === 0) return;

    const exportData = invalidRows.map((r) => ({
      'Excel Row': r.rowNumber,
      'Candidate Name': r.candidate_name,
      'School Name': r.school_name,
      Location: r.location,
      District: r.district,
      'Mobile Number': r.phone,
      Email: r.email,
      'Joining Date': r.joining_date,
      'Validation Issues': r.errors.join('; '),
    }));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(exportData), 'Import Errors');
    XLSX.writeFile(wb, 'Kalvi40_Import_Error_Report.xlsx');
  }

  async function confirmImport() {
    const eligible = validatedRows.filter((r) => {
      const nonDupErrors = r.errors.filter((e) => e !== 'Already Exists in Database');
      if (nonDupErrors.length > 0) return false;
      if (r.isDuplicateInDb && skipDuplicates) return false;
      return true;
    });

    if (eligible.length === 0) {
      toast({ title: 'No eligible records', description: 'Fix invalid rows before importing.', variant: 'warning' });
      return;
    }

    setImporting(true);
    try {
      const res = await apiRequest<{ importedCount: number; skippedCount: number }>('/api/candidates/bulk-import', {
        method: 'POST',
        body: JSON.stringify({
          skipDuplicates,
          records: eligible.map((r) => ({
            candidate_name: r.candidate_name,
            school_name: r.school_name,
            location: r.location,
            district: r.district,
            phone: r.phone,
            email: r.email,
            joining_date: r.joining_date,
          })),
        }),
      });
      setImportResult(res);
      setStep(5);
      toast({
        title: 'Bulk Import Completed',
        description: `Imported ${res.importedCount} candidates successfully.`,
        variant: 'success',
      });
    } catch (err) {
      toast({ title: 'Import failed', description: err instanceof Error ? err.message : 'Error', variant: 'error' });
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-[#10243A] tracking-tight">Bulk Excel Candidate Import</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Upload .xlsx or .csv sheets with 50–500+ candidates, map columns, validate records, and resolve errors inline.
          </p>
        </div>
        <button
          type="button"
          onClick={downloadSampleTemplate}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-[#10243A] bg-white border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap shrink-0"
        >
          <Download className="w-3.5 h-3.5" />
          <span>Download Sample Template (Mobile Number included)</span>
        </button>
      </div>

      {/* Stepper Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 grid grid-cols-5 gap-2 text-xs">
        {[
          { num: 1, label: '01. Upload Excel' },
          { num: 2, label: '02. Map Columns' },
          { num: 3, label: '03. Validate Records' },
          { num: 4, label: '04. Preview & Edit' },
          { num: 5, label: '05. Confirm Import' },
        ].map((s) => (
          <div
            key={s.num}
            className={`px-3 py-2 rounded-lg font-medium truncate ${
              step === s.num
                ? 'bg-[#2563EB] text-white'
                : step > s.num
                ? 'bg-emerald-50 text-[#16A36A]'
                : 'bg-[#F7F8FA] text-slate-500'
            }`}
          >
            {s.label}
          </div>
        ))}
      </div>

      {/* STEP 1: UPLOAD */}
      {step === 1 && (
        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center">
          <label className="block border-2 border-dashed border-slate-300 hover:border-[#2563EB] rounded-xl p-12 cursor-pointer transition-colors">
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFileSelect(file);
              }}
            />
            <Upload className="w-10 h-10 text-[#2563EB] mx-auto mb-3" />
            <div className="text-base font-semibold text-[#10243A]">Click to select an Excel (.xlsx) or CSV file</div>
            <p className="text-xs text-slate-500 mt-1.5">
              Expected columns: Candidate Name | School Name | Location | District | Mobile Number | Email | Joining Date
            </p>
          </label>
        </div>
      )}

      {/* STEP 2: MAP COLUMNS */}
      {step === 2 && (
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
          <div className="flex items-center justify-between border-b border-slate-200 pb-4">
            <div className="flex items-center gap-2.5">
              <FileSpreadsheet className="w-5 h-5 text-[#2563EB]" />
              <div>
                <div className="text-sm font-semibold text-[#10243A]">{fileName}</div>
                <div className="text-xs text-slate-500 tabular-nums">{rawRows.length} rows detected</div>
              </div>
            </div>
            <button type="button" onClick={() => setStep(1)} className="text-xs font-medium text-slate-500 hover:text-[#10243A]">
              Choose Different File
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {TARGET_FIELDS.map((tf) => (
              <div key={tf.key} className="p-3.5 border border-slate-200 rounded-lg bg-[#F7F8FA]">
                <label className="block text-xs font-semibold text-[#10243A] mb-1.5">{tf.label}</label>
                <select
                  value={columnMap[tf.key]}
                  onChange={(e) => setColumnMap({ ...columnMap, [tf.key]: e.target.value })}
                  className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
                >
                  <option value="">-- Select Excel Column --</option>
                  {rawHeaders.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-200">
            <button
              type="button"
              onClick={() => setStep(1)}
              className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg"
            >
              Back
            </button>
            <button
              type="button"
              onClick={runValidationStep}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#2563EB] hover:bg-blue-700 rounded-lg"
            >
              <span>Validate Records</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* STEP 3 & 4: VALIDATE, PREVIEW & EDIT */}
      {(step === 3 || step === 4) && (
        <div className="space-y-5">
          {/* Validation Summary */}
          <div className="bg-white border border-slate-200 rounded-xl grid grid-cols-2 sm:grid-cols-5 divide-y sm:divide-y-0 sm:divide-x divide-slate-200">
            <div className="p-4">
              <div className="text-xs text-slate-500">Total Records</div>
              <div className="text-xl font-bold text-[#10243A] tabular-nums mt-1">{summary.total}</div>
            </div>
            <div className="p-4">
              <div className="text-xs text-slate-500">Valid Records</div>
              <div className="text-xl font-bold text-[#16A36A] tabular-nums mt-1">{summary.valid}</div>
            </div>
            <div className="p-4">
              <div className="text-xs text-slate-500">Invalid Records</div>
              <div className="text-xl font-bold text-[#DC4545] tabular-nums mt-1">{summary.invalid}</div>
            </div>
            <div className="p-4">
              <div className="text-xs text-slate-500">Duplicate Records</div>
              <div className="text-xl font-bold text-[#D97706] tabular-nums mt-1">{summary.duplicates}</div>
            </div>
            <div className="p-4">
              <div className="text-xs text-slate-500">Missing Fields</div>
              <div className="text-xl font-bold text-[#DC4545] tabular-nums mt-1">{summary.missing}</div>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-4">
                <span className="text-sm font-semibold text-[#10243A]">
                  {step === 3 ? 'Validation Results (Click any field below to edit inline)' : 'Final Import Preview'}
                </span>
                <label className="inline-flex items-center gap-2 text-xs text-slate-700">
                  <input
                    type="checkbox"
                    checked={skipDuplicates}
                    onChange={(e) => setSkipDuplicates(e.target.checked)}
                  />
                  <span>Skip emails already in database</span>
                </label>
              </div>
              <div className="flex items-center gap-2">
                {summary.invalid > 0 && (
                  <button
                    type="button"
                    onClick={downloadErrorReport}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#DC4545] bg-red-50 border border-red-200 rounded-lg hover:bg-red-100"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Download Error Report (.xlsx)</span>
                  </button>
                )}
              </div>
            </div>

            <div className="overflow-x-auto max-h-[460px]">
              <table className="w-full text-left border-collapse text-xs">
                <thead className="sticky top-0 bg-[#F7F8FA] border-b border-slate-200 text-[11px] font-semibold text-slate-500">
                  <tr>
                    <th className="py-2.5 px-3">Row</th>
                    <th className="py-2.5 px-3">Candidate Name</th>
                    <th className="py-2.5 px-3">School Name</th>
                    <th className="py-2.5 px-3">Location</th>
                    <th className="py-2.5 px-3">District</th>
                    <th className="py-2.5 px-3">Mobile Number</th>
                    <th className="py-2.5 px-3">Email</th>
                    <th className="py-2.5 px-3">Joining Date</th>
                    <th className="py-2.5 px-3">Validation</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {validatedRows.map((row, idx) => (
                    <tr key={row.rowNumber} className={row.isValid ? '' : 'bg-red-50/40'}>
                      <td className="py-2 px-3 font-mono text-slate-400 tabular-nums">{row.rowNumber}</td>
                      <td className="py-1.5 px-2">
                        <input
                          type="text"
                          value={row.candidate_name}
                          onChange={(e) => updateCell(idx, 'candidate_name', e.target.value)}
                          className="w-40 px-2 py-1 border border-slate-200 rounded bg-white text-xs"
                        />
                      </td>
                      <td className="py-1.5 px-2">
                        <input
                          type="text"
                          value={row.school_name}
                          onChange={(e) => updateCell(idx, 'school_name', e.target.value)}
                          className="w-48 px-2 py-1 border border-slate-200 rounded bg-white text-xs"
                        />
                      </td>
                      <td className="py-1.5 px-2">
                        <input
                          type="text"
                          value={row.location}
                          onChange={(e) => updateCell(idx, 'location', e.target.value)}
                          className="w-32 px-2 py-1 border border-slate-200 rounded bg-white text-xs"
                        />
                      </td>
                      <td className="py-1.5 px-2">
                        <input
                          type="text"
                          value={row.district}
                          onChange={(e) => updateCell(idx, 'district', e.target.value)}
                          className="w-32 px-2 py-1 border border-slate-200 rounded bg-white text-xs"
                        />
                      </td>
                      <td className="py-1.5 px-2">
                        <input
                          type="text"
                          value={row.phone}
                          onChange={(e) => updateCell(idx, 'phone', e.target.value)}
                          className="w-32 px-2 py-1 border border-slate-200 rounded bg-white text-xs"
                        />
                      </td>
                      <td className="py-1.5 px-2">
                        <input
                          type="text"
                          value={row.email}
                          onChange={(e) => updateCell(idx, 'email', e.target.value)}
                          className="w-48 px-2 py-1 border border-slate-200 rounded bg-white font-mono text-[11px]"
                        />
                      </td>
                      <td className="py-1.5 px-2">
                        <input
                          type="text"
                          value={row.joining_date}
                          onChange={(e) => updateCell(idx, 'joining_date', e.target.value)}
                          className="w-24 px-2 py-1 border border-slate-200 rounded bg-white font-mono text-[11px]"
                        />
                      </td>
                      <td className="py-2 px-3 whitespace-nowrap">
                        {row.isValid ? (
                          <span className="inline-flex items-center gap-1 text-[#16A36A] font-medium">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>Valid</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[#DC4545] font-medium" title={row.errors.join(', ')}>
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                            <span>{row.errors[0]}</span>
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="px-5 py-4 bg-[#F7F8FA] border-t border-slate-200 flex items-center justify-between">
              <button
                type="button"
                onClick={() => setStep(step === 4 ? 3 : 2)}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Back</span>
              </button>

              {step === 3 ? (
                <button
                  type="button"
                  onClick={() => setStep(4)}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#2563EB] hover:bg-blue-700 rounded-lg"
                >
                  <span>Proceed to Import Preview</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              ) : (
                <button
                  type="button"
                  disabled={importing}
                  onClick={confirmImport}
                  className="px-5 py-2 text-xs font-semibold text-white bg-[#16A36A] hover:bg-emerald-700 rounded-lg disabled:opacity-50"
                >
                  {importing ? 'Importing Candidates...' : `Confirm Import (${summary.valid} Valid Records)`}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* STEP 5: IMPORT COMPLETE */}
      {step === 5 && importResult && (
        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center space-y-4">
          <CheckCircle2 className="w-12 h-12 text-[#16A36A] mx-auto" />
          <h3 className="text-lg font-bold text-[#10243A]">Excel Import Completed</h3>
          <p className="text-sm text-slate-600 tabular-nums">
            Imported <strong>{importResult.importedCount}</strong> candidate record(s) into the database
            {importResult.skippedCount > 0 ? ` (${importResult.skippedCount} duplicate/invalid row(s) skipped)` : ''}.
          </p>
          <div className="flex items-center justify-center gap-3 pt-2">
            <button
              type="button"
              onClick={() => {
                setStep(1);
                setRawRows([]);
                setValidatedRows([]);
                setImportResult(null);
              }}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Import Another File</span>
            </button>
            <button
              type="button"
              onClick={() => onNavigate('candidates')}
              className="px-4 py-2 text-xs font-semibold text-white bg-[#2563EB] hover:bg-blue-700 rounded-lg"
            >
              View Candidates Directory
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
