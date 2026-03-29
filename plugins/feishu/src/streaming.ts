/**
 * Feishu Streaming Card — CardKit API with fallback to PATCH-edit text message.
 *
 * CardKit flow (requires cardkit:card:write):
 *   1. POST /cardkit/v1/cards                                    → create card entity
 *   2. client.im.message.create/reply                            → send interactive msg
 *   3. PUT  /cardkit/v1/cards/:id/elements/progress/content      → append progress lines
 *   4. PUT  /cardkit/v1/cards/:id/elements/content/content       → stream main text
 *   5. PATCH /cardkit/v1/cards/:id/elements/panel                → collapse panel
 *   6. PATCH /cardkit/v1/cards/:id/settings                      → close streaming_mode
 *
 * Fallback flow (no extra permissions):
 *   1. client.im.message.create/reply  → send placeholder text message
 *   2. client.im.message.patch         → edit on each update
 */

import type { Client } from '@larksuiteoapi/node-sdk';

export interface StreamingCardOptions {
  throttleMs?: number;
}

type CardKitState = {
  mode: 'cardkit';
  cardId: string;
  messageId: string;
  sequence: number;
  currentText: string;
  progressLines: string[];
};

type PatchState = {
  mode: 'patch';
  messageId: string;
  receiveId: string;
  receiveIdType: 'open_id' | 'chat_id';
  currentText: string;
};

type CardState = CardKitState | PatchState;

function resolveApiBase(domain?: string): string {
  if (domain === 'lark') return 'https://open.larksuite.com/open-apis';
  if (domain && domain !== 'feishu' && domain.startsWith('http'))
    return `${domain.replace(/\/+$/, '')}/open-apis`;
  return 'https://open.feishu.cn/open-apis';
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getToken(appId: string, appSecret: string, domain?: string): Promise<string> {
  const key = `${domain ?? 'feishu'}|${appId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const res = await fetch(`${resolveApiBase(domain)}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  if (!res.ok) throw new Error(`Token request failed: HTTP ${res.status}`);
  const data = (await res.json()) as {
    code: number; msg: string; tenant_access_token?: string; expire?: number;
  };
  if (data.code !== 0 || !data.tenant_access_token)
    throw new Error(`Token error: ${data.msg}`);
  tokenCache.set(key, {
    token: data.tenant_access_token,
    expiresAt: Date.now() + (data.expire ?? 7200) * 1000,
  });
  return data.tenant_access_token;
}

function truncateSummary(text: string, max = 50): string {
  const clean = text.replace(/\n/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 3)}...`;
}

export function mergeStreamingText(prev: string | undefined, next: string | undefined): string {
  const p = prev ?? '';
  const n = next ?? '';
  if (!n) return p;
  if (!p || n === p) return n;
  if (n.startsWith(p)) return n;
  if (p.startsWith(n)) return p;
  if (n.includes(p)) return n;
  if (p.includes(n)) return p;
  const maxOverlap = Math.min(p.length, n.length);
  for (let i = maxOverlap; i > 0; i--) {
    if (p.slice(-i) === n.slice(0, i)) return `${p}${n.slice(i)}`;
  }
  return `${p}${n}`;
}

export class FeishuStreamingCard {
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly domain: string | undefined;
  private readonly client: Client;
  private readonly throttleMs: number;

  private state: CardState | null = null;
  private startPromise: Promise<void> | null = null;
  private closed = false;
  private queue: Promise<void> = Promise.resolve();
  private pendingText: string | null = null;
  private lastUpdateTime = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    client: Client,
    appId: string,
    appSecret: string,
    domain?: string,
    options?: StreamingCardOptions,
  ) {
    this.client = client;
    this.appId = appId;
    this.appSecret = appSecret;
    this.domain = domain;
    this.throttleMs = options?.throttleMs ?? 100;
  }

  async start(
    receiveId: string,
    receiveIdType: 'open_id' | 'chat_id',
    replyToMessageId?: string,
  ): Promise<void> {
    if (this.startPromise) return this.startPromise;
    // Enqueue start into the serial queue so all subsequent operations
    // (appendProgress, update, close) naturally wait for it.
    this.startPromise = new Promise<void>((resolve, reject) => {
      this.queue = this.queue.then(async () => {
        try {
          await this._doStart(receiveId, receiveIdType, replyToMessageId);
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });
    return this.startPromise;
  }

  private async _doStart(
    receiveId: string,
    receiveIdType: 'open_id' | 'chat_id',
    replyToMessageId?: string,
  ): Promise<void> {
    try {
      await this._startCardKit(receiveId, receiveIdType, replyToMessageId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[FeishuStreamingCard] CardKit failed (${msg.slice(0, 120)}), falling back to patch mode`);
      await this._startPatch(receiveId, receiveIdType, replyToMessageId);
    }
  }

  private async _startCardKit(
    receiveId: string,
    receiveIdType: 'open_id' | 'chat_id',
    replyToMessageId?: string,
  ): Promise<void> {
    const apiBase = resolveApiBase(this.domain);
    const token = await getToken(this.appId, this.appSecret, this.domain);

    // collapsible panel on top (progress), hr, then main content below
    const cardJson = {
      schema: '2.0',
      config: {
        streaming_mode: true,
        summary: { content: '[Generating...]' },
        streaming_config: { print_frequency_ms: { default: 50 }, print_step: { default: 1 } },
      },
      body: {
        elements: [
          {
            tag: 'collapsible_panel',
            element_id: 'panel',
            expanded: true,
            header: {
              title: { tag: 'markdown', content: '**进度详情**' },
              background_color: 'grey',
              padding: '4px 0px 4px 8px',
              icon: { tag: 'standard_icon', token: 'down-small_outlined', color: 'grey' },
              icon_position: 'left',
              icon_expanded_angle: -180,
            },
            elements: [
              { tag: 'markdown', content: '⏳ 处理中...', element_id: 'progress' },
            ],
          },
          { tag: 'hr' },
          { tag: 'markdown', content: ' ', element_id: 'content' },
        ],
      },
    };

    const createRes = await fetch(`${apiBase}/cardkit/v1/cards`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'card_json', data: JSON.stringify(cardJson) }),
    });
    if (!createRes.ok) {
      const body = await createRes.text();
      throw new Error(`Create card failed: HTTP ${createRes.status} — ${body}`);
    }
    const createData = (await createRes.json()) as {
      code: number; msg: string; data?: { card_id: string };
    };
    if (createData.code !== 0 || !createData.data?.card_id)
      throw new Error(`Create card failed: code=${createData.code} msg=${createData.msg}`);

    const cardId = createData.data.card_id;
    const cardContent = JSON.stringify({ type: 'card', data: { card_id: cardId } });

    let messageId: string;
    if (replyToMessageId) {
      const res = await this.client.im.message.reply({
        path: { message_id: replyToMessageId },
        data: { msg_type: 'interactive', content: cardContent },
      });
      if (res.code !== 0 || !res.data?.message_id)
        throw new Error(`Send card reply failed: ${res.msg}`);
      messageId = res.data.message_id;
    } else {
      const res = await this.client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: { receive_id: receiveId, msg_type: 'interactive', content: cardContent },
      });
      if (res.code !== 0 || !res.data?.message_id)
        throw new Error(`Send card failed: ${res.msg}`);
      messageId = res.data.message_id;
    }

    this.state = { mode: 'cardkit', cardId, messageId, sequence: 1, currentText: '', progressLines: [] };
  }

  private async _startPatch(
    receiveId: string,
    receiveIdType: 'open_id' | 'chat_id',
    replyToMessageId?: string,
  ): Promise<void> {
    const placeholder = JSON.stringify({ text: '⏳ 处理中...' });
    let messageId: string;
    if (replyToMessageId) {
      const res = await this.client.im.message.reply({
        path: { message_id: replyToMessageId },
        data: { msg_type: 'text', content: placeholder },
      });
      if (res.code !== 0 || !res.data?.message_id)
        throw new Error(`Send placeholder failed: ${res.msg}`);
      messageId = res.data.message_id;
    } else {
      const res = await this.client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: { receive_id: receiveId, msg_type: 'text', content: placeholder },
      });
      if (res.code !== 0 || !res.data?.message_id)
        throw new Error(`Send placeholder failed: ${res.msg}`);
      messageId = res.data.message_id;
    }
    this.state = { mode: 'patch', messageId, receiveId, receiveIdType, currentText: '' };
  }

  /** Stream main content chunk (throttled). */
  async update(text: string): Promise<void> {
    if (this.closed) return;
    if (!this.state && !this.startPromise) return;

    const merged = mergeStreamingText(this.pendingText ?? (this.state?.currentText ?? ''), text);
    if (!merged) return;

    const now = Date.now();
    if (now - this.lastUpdateTime < this.throttleMs) {
      this.pendingText = merged;
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
          const pending = this.pendingText;
          if (pending !== null) { this.pendingText = null; void this.update(pending); }
        }, this.throttleMs);
      }
      return;
    }

    this.pendingText = null;
    this.lastUpdateTime = now;
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }

    const textToSend = merged;
    this.queue = this.queue.then(async () => {
      if (!this.state || this.closed) return;
      const final = mergeStreamingText(this.state.currentText, textToSend);
      if (!final || final === this.state.currentText) return;
      this.state.currentText = final;
      await this._putContent(final);
    });
    await this.queue;
  }

  /** Overwrite progress area without touching main content (patch fallback). */
  async overwrite(text: string): Promise<void> {
    if (this.closed || !this.state) return;
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    this.queue = this.queue.then(async () => {
      if (!this.state || this.closed) return;
      await this._putContent(text);
    });
    await this.queue;
  }

  /**
   * Append a progress line to the collapsible panel.
   * CardKit: updates the `progress` element inside the panel.
   * Patch fallback: overwrites the message text.
   */
  async appendProgress(line: string): Promise<void> {
    this.queue = this.queue.then(async () => {
      if (!this.state) return;
      if (this.state.mode === 'cardkit') {
        const isNewBlock = line.startsWith('🔧') || line.startsWith('✅') || line.startsWith('❌');
        if (isNewBlock && this.state.progressLines.length > 0) {
          this.state.progressLines.push('· · ·');
        }
        this.state.progressLines.push(line);
        const content = this.state.progressLines.join('\n');
        await this._putElementContent('progress', content);
      } else {
        await this._putContent(line);
      }
    });
    await this.queue;
  }

  /** Finalize with complete text, collapse progress panel, close streaming mode. */
  async close(finalText?: string): Promise<void> {
    if (this.closed) return;
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }

    if (this.startPromise) {
      try { await this.startPromise; } catch { this.closed = true; return; }
    }
    if (!this.state) { this.closed = true; return; }

    // Wait for all queued operations (appendProgress, update) to complete
    await this.queue;

    // NOW mark as closed — after all pending operations have finished
    this.closed = true;

    const pending = mergeStreamingText(this.state.currentText, this.pendingText ?? undefined);
    const text = finalText ? mergeStreamingText(pending, finalText) : pending;

    if (text && text !== this.state.currentText) {
      await this._putContent(text);
      this.state.currentText = text;
    }

    if (this.state.mode === 'cardkit') {
      await this._closeCardKit(text ?? '');
    } else if (text) {
      // patch mode: text messages can't be edited — send final text as a new message
      const { receiveId, receiveIdType } = this.state;
      try {
        await this.client.im.message.create({
          params: { receive_id_type: receiveIdType },
          data: { receive_id: receiveId, msg_type: 'text', content: JSON.stringify({ text }) },
        });
      } catch (err) {
        console.error('[FeishuStreamingCard] patch final send error:', err);
      }
    }

    this.state = null;
    this.pendingText = null;
  }

  isActive(): boolean {
    return (this.state !== null || this.startPromise !== null) && !this.closed;
  }

  private async _putContent(text: string): Promise<void> {
    if (!this.state) return;
    if (this.state.mode === 'cardkit') {
      await this._putElementContent('content', text);
    } else {
      // patch mode: text messages cannot be edited via API.
      // Only send on close (handled by close()), skip intermediate updates.
    }
  }

  /** PUT /elements/:elementId/content — stream-update a markdown element's text. */
  private async _putElementContent(elementId: string, content: string): Promise<void> {
    if (!this.state || this.state.mode !== 'cardkit') return;
    const apiBase = resolveApiBase(this.domain);
    const token = await getToken(this.appId, this.appSecret, this.domain);
    this.state.sequence += 1;
    try {
      const res = await fetch(
        `${apiBase}/cardkit/v1/cards/${this.state.cardId}/elements/${elementId}/content`,
        {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content,
            sequence: this.state.sequence,
            uuid: `${elementId}_${this.state.cardId}_${this.state.sequence}`,
          }),
        },
      );
      if (!res.ok) {
        const body = await res.text();
        console.error(`[FeishuStreamingCard] PUT ${elementId} failed: HTTP ${res.status} ${body}`);
      }
    } catch (err) {
      console.error(`[FeishuStreamingCard] PUT ${elementId} error:`, err);
    }
  }

  /**
   * PATCH /elements/:elementId — update element properties (not tag).
   * Used to set expanded: false on the collapsible panel.
   */
  private async _patchElementProps(
    elementId: string,
    properties: Record<string, unknown>,
  ): Promise<void> {
    if (!this.state || this.state.mode !== 'cardkit') return;
    const apiBase = resolveApiBase(this.domain);
    const token = await getToken(this.appId, this.appSecret, this.domain);
    this.state.sequence += 1;
    try {
      const res = await fetch(
        `${apiBase}/cardkit/v1/cards/${this.state.cardId}/elements/${elementId}`,
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            partial_element: JSON.stringify(properties),
            sequence: this.state.sequence,
            uuid: `patch_${elementId}_${this.state.cardId}_${this.state.sequence}`,
          }),
        },
      );
      if (!res.ok) {
        const body = await res.text();
        console.error(`[FeishuStreamingCard] PATCH ${elementId} failed: HTTP ${res.status} ${body}`);
      }
    } catch (err) {
      console.error(`[FeishuStreamingCard] PATCH ${elementId} error:`, err);
    }
  }

  private async _closeCardKit(finalText: string): Promise<void> {
    if (!this.state || this.state.mode !== 'cardkit') return;
    const apiBase = resolveApiBase(this.domain);
    const token = await getToken(this.appId, this.appSecret, this.domain);

    // Collapse the progress panel — PATCH with just expanded: false
    await this._patchElementProps('panel', { expanded: false });
    // Close streaming mode
    this.state.sequence += 1;
    try {
      const res = await fetch(`${apiBase}/cardkit/v1/cards/${this.state.cardId}/settings`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          settings: JSON.stringify({
            config: { streaming_mode: false, summary: { content: truncateSummary(finalText) } },
          }),
          sequence: this.state.sequence,
          uuid: `close_${this.state.cardId}_${this.state.sequence}`,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        console.error(`[FeishuStreamingCard] PATCH settings failed: HTTP ${res.status} ${body}`);
      }
    } catch (err) {
      console.error('[FeishuStreamingCard] PATCH settings error:', err);
    }
  }
}
