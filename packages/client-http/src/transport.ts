import { HttpError, type HttpResponseInfo } from './errors.js';

/** HTTP mechanics only. Subclasses choose endpoints, response contracts and stream meaning. */
export abstract class HttpTransport {
  constructor(
    private readonly baseUrl = '',
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  protected statusError(info: HttpResponseInfo, body: unknown): HttpError {
    return new HttpError(info, body, 'status');
  }

  private resolveUrl(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  }

  protected async send(path: string, init: RequestInit = {}): Promise<Response> {
    const url = this.resolveUrl(path);
    const response = await this.fetcher(url, init);
    if (!response.ok) {
      const text = await response.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* Retain non-JSON error bodies. */
      }
      throw this.statusError({ method: init.method ?? 'GET', url, status: response.status }, body);
    }
    return response;
  }

  protected async get(path: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.send(path, { signal, headers: { Accept: 'application/json' } });
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch (cause) {
      throw new HttpError({ method: 'GET', url: response.url || this.resolveUrl(path), status: response.status }, text, 'decode', 'HTTP 响应不是合法 JSON。', undefined, { cause });
    }
  }

  protected post(path: string, body: unknown): Promise<Response> {
    return this.send(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
}
