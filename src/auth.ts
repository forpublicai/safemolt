import NextAuth from "next-auth";
import Cognito from "next-auth/providers/cognito";

const cognitoConfigured =
  Boolean(process.env.AUTH_COGNITO_ID) &&
  Boolean(process.env.AUTH_COGNITO_SECRET) &&
  Boolean(process.env.AUTH_COGNITO_ISSUER);

// In production (AUTH_URL set to safemolt.com), share the session cookie across all
// *.safemolt.com subdomains so a single Cognito callback URL handles all schools.
const isProduction = process.env.AUTH_URL?.includes("safemolt.com");

export const { handlers, signIn, signOut, auth } = NextAuth({
  trustHost: true,
  /** Use app login (client `signIn`) instead of default `/api/auth/signin` HTML forms — avoids broken CSRF/post flows after OAuth errors. */
  pages: {
    signIn: "/login",
    /** Avoid default `/api/auth/error` (opaque 500s); show `/login?error=…` with hints instead. */
    error: "/login",
  },
  debug: process.env.NODE_ENV === "development",
  // Share session cookie across *.safemolt.com so login on safemolt.com works on subdomains
  ...(isProduction ? {
    cookies: {
      sessionToken: {
        name: "__Secure-next-auth.session-token",
        options: {
          httpOnly: true,
          sameSite: "lax" as const,
          path: "/",
          secure: true,
          domain: ".safemolt.com",
        },
      },
    },
  } : {}),
  providers: cognitoConfigured
    ? [
        Cognito({
          clientId: process.env.AUTH_COGNITO_ID!,
          clientSecret: process.env.AUTH_COGNITO_SECRET!,
          issuer: process.env.AUTH_COGNITO_ISSUER!.replace(/\/+$/, ""),
          /**
           * Default Auth.js OAuth checks are `["pkce"]` only. OIDC callbacks still validate the
           * ID token; if Cognito returns a `nonce` claim (common with federated IdPs like Google),
           * oauth4webapi rejects the token when no nonce was sent/expected ("unexpected ID Token
           * nonce claim value" with expected undefined). Including `nonce` aligns authorize +
           * token validation.
           */
          checks: ["pkce", "nonce"],
          authorization: {
            params: {
              scope: "openid email profile",
            },
          },
        }),
      ]
    : [],
  callbacks: {
    async jwt({ token, profile, account }) {
      if (account && profile && typeof profile.sub === "string") {
        try {
          const { upsertHumanUserByCognitoSub } = await import("@/lib/human-users");
          const row = await upsertHumanUserByCognitoSub({
            cognitoSub: profile.sub,
            email: typeof profile.email === "string" ? profile.email : undefined,
            name: typeof profile.name === "string" ? profile.name : undefined,
          });
          token.humanUserId = row.id;
        } catch (e) {
          console.error("[auth] upsertHumanUserByCognitoSub failed:", e);
          token.humanUserId = `err_${profile.sub}`;
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.humanUserId) {
        session.user.id = token.humanUserId as string;
      }
      return session;
    },
    // After sign-in, send users to /dashboard unless they have a specific destination.
    // Cognito may return baseUrl (homepage) when there's no callbackUrl — always upgrade that to /dashboard.
    redirect({ url, baseUrl }) {
      try {
        const u = new URL(url);
        // Allow any *.safemolt.com destination, but upgrade bare root → /dashboard
        if (u.hostname === "safemolt.com" || u.hostname.endsWith(".safemolt.com")) {
          if (u.pathname === "/" || u.pathname === "") {
            return `${baseUrl}/dashboard`;
          }
          return url;
        }
      } catch {
        // Relative URL — upgrade bare "/" to /dashboard
        if (url === "/") return `${baseUrl}/dashboard`;
      }
      // Fallback: always land on dashboard, never the homepage
      return `${baseUrl}/dashboard`;
    },
  },
});
