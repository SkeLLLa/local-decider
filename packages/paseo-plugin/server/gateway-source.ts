import { TOKEN_ENV, TOKEN_ORIGIN_ENV } from '../shared/constants.ts';
import { createGateway, type Gateway, type GatewayOptions } from '../shared/gateway.ts';
import { bearerAllowed, loopbackUrl, originOf } from '../shared/url.ts';
import { readLocalToken } from './deps.ts';

export interface GatewaySourceOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly log: (message: string) => void;
  readonly create?: typeof createGateway;
}

/** Builds the Gateway for a URL with scoped credentials, cached per URL. */
export function gatewaySource(options: GatewaySourceOptions): (url: string) => Gateway | null {
  const env = options.env ?? process.env;
  const create = options.create ?? createGateway;
  let report: string | undefined;
  let control: string | undefined;
  let cached: { url: string; gateway: Gateway | null } | null = null;
  const warned = new Set<string>();

  function refreshTokens(): boolean {
    let changed = false;
    if (report === undefined) {
      const next = readLocalToken('report-token', env);
      changed = changed || next !== report;
      report = next;
    }
    if (control === undefined) {
      const next = readLocalToken('control-token', env);
      changed = changed || next !== control;
      control = next;
    }
    return changed;
  }

  function invalidate(): void {
    report = undefined;
    control = undefined;
    cached = null;
  }

  function warnWithheld(
    url: string,
    token: string | undefined,
    tokenOrigin: string | undefined,
  ): void {
    const origin = originOf(url);
    if (
      token === undefined ||
      loopbackUrl(url) ||
      bearerAllowed(url, tokenOrigin) ||
      origin === null ||
      warned.has(origin)
    )
      return;
    const reason = origin.startsWith('https://')
      ? 'set LOCAL_DECIDER_TOKEN_ORIGIN in the daemon environment to send it'
      : 'a remote gateway must use https';
    options.log(`bearer withheld from ${origin}: ${reason}`);
    warned.add(origin);
  }

  function build(url: string): Gateway | null {
    const token = env[TOKEN_ENV] || undefined;
    const tokenOrigin = env[TOKEN_ORIGIN_ENV] || undefined;
    warnWithheld(url, token, tokenOrigin);
    const gatewayOptions: GatewayOptions = {
      baseUrl: url,
      token,
      tokenOrigin,
      reportToken: report,
      controlToken: control,
      onUnauthorised: invalidate,
    };
    return create(gatewayOptions);
  }

  return (url) => {
    const changed = refreshTokens();
    if (changed || cached?.url !== url) {
      cached = { url, gateway: build(url) };
    }
    return cached.gateway;
  };
}
