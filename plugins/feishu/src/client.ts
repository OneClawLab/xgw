import * as Lark from '@larksuiteoapi/node-sdk';

export interface FeishuClientOptions {
  appId: string;
  appSecret: string;
  domain?: 'feishu' | 'lark' | string;
}

/** Map domain string to Lark.Domain enum or custom URL string. */
function resolveDomain(domain?: string): Lark.Domain | string {
  if (!domain || domain === 'feishu') return Lark.Domain.Feishu;
  if (domain === 'lark') return Lark.Domain.Lark;
  return domain; // custom URL string
}

/** Create a Feishu REST API Client. */
export function createClient(opts: FeishuClientOptions): Lark.Client {
  return new Lark.Client({
    appId: opts.appId,
    appSecret: opts.appSecret,
    domain: resolveDomain(opts.domain),
  });
}

/** Create a Feishu EventDispatcher (no encryptKey/verificationToken needed for WS mode). */
export function createDispatcher(): Lark.EventDispatcher {
  return new Lark.EventDispatcher({});
}

/** Create a Feishu WebSocket Client. */
export function createWSClient(
  opts: FeishuClientOptions,
  dispatcher: Lark.EventDispatcher,
): Lark.WSClient {
  const wsClient = new Lark.WSClient({
    appId: opts.appId,
    appSecret: opts.appSecret,
    domain: resolveDomain(opts.domain),
  });
  // Store dispatcher reference for use in start()
  // WSClient.start({ eventDispatcher }) is called externally
  void dispatcher; // referenced by caller
  return wsClient;
}

interface BotInfoResponse {
  code?: number;
  msg?: string;
  bot?: {
    open_id?: string;
    [key: string]: unknown;
  };
}

/**
 * Validate credentials by obtaining a tenant_access_token and fetching bot info.
 * Returns { botOpenId } on success, throws a descriptive Error on failure.
 */
export async function validateCredentials(
  client: Lark.Client,
): Promise<{ botOpenId: string }> {
  // Step 1: Verify credentials by getting tenant_access_token
  const tokenResp = await client.auth.tenantAccessToken.internal({
    data: {
      app_id: client.appId,
      app_secret: client.appSecret,
    },
  });

  if (tokenResp.code !== 0) {
    throw new Error(
      `Feishu credential validation failed: ${tokenResp.msg ?? 'unknown error'} (code: ${tokenResp.code ?? 'unknown'})`,
    );
  }

  // Step 2: Get bot info to retrieve open_id
  const botResp = await client.request<BotInfoResponse>({
    method: 'GET',
    url: '/open-apis/bot/v3/info',
  });

  const botOpenId = botResp.bot?.open_id;
  if (!botOpenId) {
    throw new Error('Feishu credential validation failed: could not retrieve bot open_id');
  }

  return { botOpenId };
}
