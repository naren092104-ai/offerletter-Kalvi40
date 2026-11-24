const TOKEN_KEY = 'kalvi40_admin_token';

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

export function getAuthToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setAuthToken(token: string | null): void {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_KEY);
  }
}

export class ApiError extends Error {
  status: number;
  data: unknown;

  constructor(message: string, status: number, data?: unknown) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export function getApiUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;

  if (!API_BASE) {
    if (import.meta.env.PROD) {
      throw new ApiError(
        'The API backend is not configured. Set VITE_API_BASE_URL to the deployed Express API URL in Cloudflare Pages, then rebuild the frontend.',
        503,
      );
    }
    return normalizedPath;
  }

  if (import.meta.env.PROD) {
    let configuredOrigin: string;
    try {
      configuredOrigin = new URL(API_BASE).origin;
    } catch {
      throw new ApiError('VITE_API_BASE_URL must be a valid absolute URL for the deployed API.', 503);
    }

    if (configuredOrigin === window.location.origin) {
      throw new ApiError(
        'VITE_API_BASE_URL points to the static Cloudflare Pages site. Set it to the separate Express API URL and rebuild.',
        503,
      );
    }
  }

  return `${API_BASE}${normalizedPath}`;
}

let onUnauthorizedCallback: (() => void) | null = null;
export function registerUnauthorizedHandler(cb: () => void): void {
  onUnauthorizedCallback = cb;
}

export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getAuthToken();
  const headers = new Headers(options.headers || {});
  if (!headers.has('Content-Type') && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(getApiUrl(path), {
    ...options,
    headers,
  });

  if (response.status === 401 && !path.startsWith('/api/auth/login')) {
    setAuthToken(null);
    if (onUnauthorizedCallback) onUnauthorizedCallback();
  }

  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json().catch(() => ({})) : await response.text();

  if (!response.ok) {
    const msg =
      typeof data === 'object' && data !== null && 'error' in data
        ? String((data as { error: string }).error)
        : `Request failed with status ${response.status}`;
    throw new ApiError(msg, response.status, data);
  }

  return data as T;
}

export function getCandidatePdfUrl(candidateId: number, mode: 'inline' | 'download' = 'inline', refresh = false): string {
  const token = getAuthToken() || '';
  const params = new URLSearchParams();
  if (mode === 'download') {
    params.set('download', '1');
  } else {
    params.set('inline', '1');
  }
  if (refresh) params.set('refresh', '1');
  if (token) params.set('token', token);
  return `${getApiUrl(`/api/candidates/${candidateId}/pdf`)}?${params.toString()}`;
}

export async function downloadAuthenticatedFile(url: string, fallbackFilename: string): Promise<void> {
  const token = getAuthToken();
  const response = await fetch(getApiUrl(url), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    const errJson = await response.json().catch(() => ({}));
    throw new Error((errJson as { error?: string }).error || `Download failed (${response.status})`);
  }
  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') || '';
  const match = disposition.match(/filename="?([^"]+)"?/i);
  const filename = match ? match[1] : fallbackFilename;

  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}
