import type {
  MailConnector,
  SyncCursor,
  SyncResult,
  SyncedEmail,
} from '../providers';

/**
 * Gmail, for real.
 *
 * The first connector that actually pulls data rather than describing how it
 * would. Everything above it — the ingestion pipeline, extraction, the
 * memory tables — already worked against seeded fixtures; this is the piece
 * that lets a real mailbox feed it.
 *
 * **Cursor strategy.** Gmail offers two: `historyId` for incremental deltas,
 * and a `q=after:` search for backfill. History expires (Google keeps roughly
 * a week) and returns 404 when it does, which is a documented and *expected*
 * state rather than an error — so an expired cursor silently falls back to a
 * dated query instead of failing the sync. A connector that dies when its
 * cursor ages out is a connector that breaks every holiday.
 *
 * **What is not fetched.** Attachments and inline images. The body text is what
 * the memory engine reads, and pulling binaries would multiply the sync cost
 * for no extraction benefit. `hasAttachments` is still recorded so the UI can
 * say one existed.
 */

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

type GmailHeader = { name?: string; value?: string };
type GmailPart = {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
};
type GmailMessage = {
  id?: string;
  threadId?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: GmailPart & { headers?: GmailHeader[] };
};

export class GmailConnector implements MailConnector {
  readonly provider = 'gmail' as const;
  readonly mode = 'live' as const;

  constructor(
    private readonly accessToken: string,
    /** The connected mailbox, used to decide inbound vs outbound. */
    private readonly selfEmail: string,
  ) {}

  async pull(cursor: SyncCursor, limit: number): Promise<SyncResult<SyncedEmail>> {
    const ids = await this.listIds(cursor, limit);
    if (ids.messages.length === 0) {
      return { items: [], nextCursor: ids.nextCursor ?? cursor, hasMore: false };
    }

    // Gmail has no bulk get, so this is one request per message. Capped by
    // `limit` upstream; the sync job pages rather than fetching a year at once.
    const items: SyncedEmail[] = [];
    for (const id of ids.messages) {
      const message = await this.get(id);
      const mapped = message && this.toSyncedEmail(message);
      if (mapped) items.push(mapped);
    }

    return { items, nextCursor: ids.nextCursor, hasMore: ids.hasMore };
  }

  /* ── Listing ───────────────────────────────────────────────────────────── */

  private async listIds(
    cursor: SyncCursor,
    limit: number,
  ): Promise<{ messages: string[]; nextCursor: SyncCursor; hasMore: boolean }> {
    if (cursor?.startsWith('history:')) {
      const historyId = cursor.slice('history:'.length);
      const delta = await this.listByHistory(historyId, limit);
      if (delta) return delta;
      // History aged out. Fall through to a dated backfill rather than fail.
      console.info('[gmail] history cursor expired; falling back to a dated query');
    }

    return this.listByQuery(cursor, limit);
  }

  private async listByHistory(
    historyId: string,
    limit: number,
  ): Promise<{ messages: string[]; nextCursor: SyncCursor; hasMore: boolean } | null> {
    const url = new URL(`${API}/history`);
    url.searchParams.set('startHistoryId', historyId);
    url.searchParams.set('historyTypes', 'messageAdded');
    url.searchParams.set('maxResults', String(Math.min(limit, 500)));

    const res = await this.fetch(url);
    // 404 means the history id is older than Gmail retains. Expected.
    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok) throw new Error(`Gmail history failed: ${res.status}`);

    const json = (await res.json()) as {
      history?: { messagesAdded?: { message?: { id?: string } }[] }[];
      historyId?: string;
      nextPageToken?: string;
    };

    const ids = new Set<string>();
    for (const entry of json.history ?? []) {
      for (const added of entry.messagesAdded ?? []) {
        if (added.message?.id) ids.add(added.message.id);
      }
    }

    return {
      messages: [...ids].slice(0, limit),
      nextCursor: json.historyId ? `history:${json.historyId}` : `history:${historyId}`,
      hasMore: Boolean(json.nextPageToken),
    };
  }

  private async listByQuery(
    cursor: SyncCursor,
    limit: number,
  ): Promise<{ messages: string[]; nextCursor: SyncCursor; hasMore: boolean }> {
    const url = new URL(`${API}/messages`);
    url.searchParams.set('maxResults', String(Math.min(limit, 500)));
    // Exclude the noise a CRM should never reason over.
    url.searchParams.set('q', '-in:chats -in:spam -in:trash -category:promotions');
    if (cursor && cursor.startsWith('page:')) {
      url.searchParams.set('pageToken', cursor.slice('page:'.length));
    }

    const res = await this.fetch(url);
    if (!res.ok) throw new Error(`Gmail list failed: ${res.status}`);

    const json = (await res.json()) as {
      messages?: { id?: string }[];
      nextPageToken?: string;
      resultSizeEstimate?: number;
    };

    const messages = (json.messages ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));

    return {
      messages,
      // Once the backfill is exhausted, switch to history for future deltas.
      nextCursor: json.nextPageToken ? `page:${json.nextPageToken}` : await this.currentHistoryCursor(),
      hasMore: Boolean(json.nextPageToken),
    };
  }

  /** The profile's current historyId, so the next run can go incremental. */
  private async currentHistoryCursor(): Promise<SyncCursor> {
    const res = await this.fetch(new URL(`${API}/profile`));
    if (!res.ok) return null;
    const json = (await res.json()) as { historyId?: string };
    return json.historyId ? `history:${json.historyId}` : null;
  }

  /* ── Fetching ──────────────────────────────────────────────────────────── */

  private async get(id: string): Promise<GmailMessage | null> {
    const url = new URL(`${API}/messages/${encodeURIComponent(id)}`);
    url.searchParams.set('format', 'full');

    const res = await this.fetch(url);
    // A message deleted between listing and fetching is normal, not an error.
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Gmail get failed: ${res.status}`);
    return (await res.json()) as GmailMessage;
  }

  private async fetch(url: URL): Promise<Response> {
    return fetch(url, {
      headers: { authorization: `Bearer ${this.accessToken}` },
      signal: AbortSignal.timeout(30_000),
    });
  }

  /* ── Mapping ───────────────────────────────────────────────────────────── */

  private toSyncedEmail(message: GmailMessage): SyncedEmail | null {
    if (!message.id) return null;

    const headers = new Map(
      (message.payload?.headers ?? [])
        .filter((h): h is { name: string; value: string } => Boolean(h.name && h.value))
        .map((h) => [h.name.toLowerCase(), h.value]),
    );

    const from = parseAddress(headers.get('from') ?? '');
    if (!from.email) return null;

    const sentAt = message.internalDate
      ? new Date(Number(message.internalDate))
      : parseDate(headers.get('date'));
    if (!sentAt) return null;

    const body = extractText(message.payload);

    return {
      externalId: message.id,
      messageId: headers.get('message-id') ?? null,
      inReplyTo: headers.get('in-reply-to') ?? null,
      threadExternalId: message.threadId ?? null,
      // SENT is authoritative; comparing the From address is the fallback for
      // mail that arrived by forwarding rather than being sent from here.
      direction:
        message.labelIds?.includes('SENT') ||
        from.email.toLowerCase() === this.selfEmail.toLowerCase()
          ? 'outbound'
          : 'inbound',
      fromEmail: from.email,
      fromName: from.name,
      toEmails: splitAddresses(headers.get('to')),
      ccEmails: splitAddresses(headers.get('cc')),
      subject: headers.get('subject') ?? '(no subject)',
      bodyText: body,
      sentAt,
      hasAttachments: hasAttachment(message.payload),
    };
  }
}

/* ── Header parsing ───────────────────────────────────────────────────────── */

/** `Dana Whitfield <dana@acme.com>` → name and address. */
export function parseAddress(raw: string): { name: string | null; email: string } {
  const angled = raw.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (angled) {
    const name = angled[1]!.replace(/^"|"$/g, '').trim();
    return { name: name || null, email: angled[2]!.trim() };
  }
  return { name: null, email: raw.trim() };
}

export function splitAddresses(raw: string | undefined): string[] {
  if (!raw) return [];
  // Split on commas that are not inside a quoted display name.
  const parts: string[] = [];
  let buffer = '';
  let quoted = false;
  for (const char of raw) {
    if (char === '"') quoted = !quoted;
    if (char === ',' && !quoted) {
      parts.push(buffer);
      buffer = '';
    } else {
      buffer += char;
    }
  }
  parts.push(buffer);

  return parts
    .map((p) => parseAddress(p).email)
    .filter((email) => email.includes('@'));
}

function parseDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * Pull the readable text out of a MIME tree.
 *
 * Prefers `text/plain`; falls back to stripping tags from `text/html`, because
 * a surprising amount of real business mail is HTML-only and skipping it would
 * lose exactly the threads that matter.
 */
export function extractText(part: GmailPart | undefined, depth = 0): string {
  if (!part || depth > 12) return '';

  if (part.mimeType === 'text/plain' && part.body?.data) {
    return decodeBody(part.body.data);
  }

  if (part.parts?.length) {
    const plain = part.parts
      .map((child) => (child.mimeType === 'text/plain' ? extractText(child, depth + 1) : ''))
      .filter(Boolean)
      .join('\n');
    if (plain.trim()) return plain;

    const nested = part.parts.map((child) => extractText(child, depth + 1)).filter(Boolean);
    if (nested.length) return nested.join('\n');
  }

  if (part.mimeType === 'text/html' && part.body?.data) {
    return stripHtml(decodeBody(part.body.data));
  }

  return '';
}

function decodeBody(data: string): string {
  try {
    // Gmail uses base64url, which Buffer handles directly.
    return Buffer.from(data, 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function hasAttachment(part: GmailPart | undefined, depth = 0): boolean {
  if (!part || depth > 12) return false;
  if (part.filename && part.filename.length > 0) return true;
  return (part.parts ?? []).some((child) => hasAttachment(child, depth + 1));
}
