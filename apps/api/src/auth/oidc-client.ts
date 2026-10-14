import * as oidc from 'openid-client';
import { z } from 'zod';
import type { OidcSettings } from './oidc-config';

export type OidcProfile = { subject: string; email: string; name: string };

export class OidcClient {
  private pending?: Promise<oidc.Configuration>;
  constructor(private readonly settings: OidcSettings) {}

  private configuration() {
    if (!this.pending) {
      this.pending = oidc.discovery(
        new URL(this.settings.issuer), this.settings.clientId,
        { client_secret: this.settings.clientSecret },
        this.settings.tokenAuthMethod === 'client_secret_post'
          ? oidc.ClientSecretPost(this.settings.clientSecret)
          : oidc.ClientSecretBasic(this.settings.clientSecret),
        {
          timeout: 10,
          execute: [oidc.enableNonRepudiationChecks, ...(this.settings.allowHTTP ? [oidc.allowInsecureRequests] : [])],
        },
      ).catch(() => {
        this.pending = undefined; // An unavailable IdP must not permanently disable SSO.
        throw new Error('OIDC_DISCOVERY_FAILED');
      });
    }
    return this.pending;
  }

  async authorizationURL(state: string, codeVerifier: string, nonce: string) {
    const config = await this.configuration();
    return oidc.buildAuthorizationUrl(config, {
      redirect_uri: this.settings.callbackURL,
      response_type: 'code',
      scope: 'openid email profile',
      state, nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
    }).href;
  }

  async profile(url: URL, state: string, codeVerifier: string, nonce: string): Promise<OidcProfile> {
    const config = await this.configuration();
    const tokens = await oidc.authorizationCodeGrant(config, url, {
      expectedState: state, expectedNonce: nonce, pkceCodeVerifier: codeVerifier, idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims) throw new Error('OIDC_ID_TOKEN_REQUIRED');
    // Some providers keep email/profile in UserInfo. Its sub must match the verified ID token.
    const profile = config.serverMetadata().userinfo_endpoint
      ? { ...claims, ...await oidc.fetchUserInfo(config, tokens.access_token, claims.sub) }
      : claims;
    if (profile.email_verified !== true) throw new Error('OIDC_VERIFIED_EMAIL_REQUIRED');
    const email = z.email().max(320).parse(profile.email).toLowerCase();
    if (this.settings.emailDomains.length && !this.settings.emailDomains.includes(email.split('@')[1])) {
      throw new Error('OIDC_EMAIL_DOMAIN_DENIED');
    }
    return {
      subject: z.string().min(1).max(255).parse(claims.sub),
      email,
      name: typeof profile.name === 'string' && profile.name.trim()
        ? profile.name.trim().slice(0, 200) : email.split('@')[0],
    };
  }
}
