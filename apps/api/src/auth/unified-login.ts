import type { PrismaClient } from "@prisma/client";
import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  dispatchAuthEndpoint,
  signInEmail,
} from "better-auth/api";
import { z } from "zod";
import { getConfig } from "../config";
import { directorySettings } from "./directory-runtime";
import {
  LoginDirectoryUnavailable,
  LoginRejected,
  registrationEnabled,
  resolveLoginRoute,
} from "./login-policy";

const body = z
  .object({
    username: z.string().trim().min(1).max(254),
    password: z
      .string()
      .min(1)
      .max(512)
      .refine((p) => !p.includes("\0")),
    rememberMe: z.boolean().default(true),
    code: z
      .string()
      .regex(/^(?:\d{6}|[A-Za-z0-9]{5}-[A-Za-z0-9]{5})$/)
      .optional(),
  })
  .strict();
export function unifiedLoginPlugin(
  db: PrismaClient,
  directory: NonNullable<BetterAuthPlugin["endpoints"]>[string],
): BetterAuthPlugin {
  const endpoint = (path: "/sign-in/unified" | "/sign-in/local-admin") =>
    createAuthEndpoint(path, { method: "POST", body }, async (ctx) => {
      const origin = ctx.headers?.get("origin");
      const origins = getConfig().auth.trustedOrigins;
      if (
        !origin ||
        !origins.includes(origin) ||
        ctx.headers?.has("authorization")
      )
        throw new APIError("FORBIDDEN", {
          message: "Trusted web origin required",
        });
      try {
        let route;
        try {
          route = await resolveLoginRoute(
            db,
            ctx.body.username,
            directorySettings,
            path === "/sign-in/local-admin",
          );
        } catch (e) {
          if (e instanceof LoginDirectoryUnavailable)
            throw new APIError("SERVICE_UNAVAILABLE", {
              code: "DIRECTORY_UNAVAILABLE",
              message: "公司身份服务暂时不可用，请稍后重试",
            });
          if (!(e instanceof LoginRejected)) throw e;
          throw new APIError("UNAUTHORIZED", {
            code: "INVALID_EMAIL_OR_PASSWORD",
            message: "账号或密码错误",
          });
        }
        // Dispatch through Better Auth's complete hook pipeline so password policy,
        // MFA, epoch stamping and all Set-Cookie headers keep their original semantics.
        return await dispatchAuthEndpoint(
          route.source === "local" ? signInEmail() : directory,
          {
            ...ctx,
            asResponse: true,
            context: {
              ...ctx.context,
              ...(route.source === "directory" && route.objectId
                ? { assayDirectoryTarget: route.objectId }
                : {}),
            },
            body:
              route.source === "local"
                ? {
                    email: route.email,
                    password: ctx.body.password,
                    rememberMe: ctx.body.rememberMe,
                  }
                : { ...ctx.body, username: route.username },
          },
        );
      } finally {
        ctx.body.password = "";
      }
    });
  return {
    id: "assay-unified-login",
    endpoints: {
      loginOptions: createAuthEndpoint(
        "/login/options",
        { method: "GET" },
        async (ctx) =>
          ctx.json({
            registrationEnabled: registrationEnabled(),
            directoryEnabled: !!directorySettings,
          }),
      ),
      unifiedSignIn: endpoint("/sign-in/unified"),
      localAdminSignIn: endpoint("/sign-in/local-admin"),
    },
  };
}
