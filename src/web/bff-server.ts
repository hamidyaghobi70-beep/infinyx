import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export type BffRouteHandler = (
  request: IncomingMessage,
  response: ServerResponse
) => void | Promise<void>;

export interface BffRouteHandlers {
  readonly startLogin: BffRouteHandler;
  readonly handleCallback: BffRouteHandler;
  readonly getSession: BffRouteHandler;
  readonly logout: BffRouteHandler;
  readonly startReauth: BffRouteHandler;
  readonly handleReauthCallback: BffRouteHandler;
  readonly startUnlinkReauth: BffRouteHandler;
  readonly handleUnlinkReauthCallback: BffRouteHandler;
  readonly unlinkIdentity: BffRouteHandler;
  readonly startLink: BffRouteHandler;
  readonly handleLinkCallback: BffRouteHandler;
}

const ROUTES = new Map<string, keyof BffRouteHandlers>([
  ["GET /auth/login", "startLogin"],
  ["GET /auth/callback", "handleCallback"],
  ["GET /api/session", "getSession"],
  ["POST /auth/logout", "logout"],
  ["POST /account/security/reauth", "startReauth"],
  ["GET /auth/reauth/callback", "handleReauthCallback"],
  ["POST /account/security/reauth-unlink", "startUnlinkReauth"],
  ["GET /auth/reauth-unlink/callback", "handleUnlinkReauthCallback"],
  ["POST /account/identities/link", "startLink"],
  ["GET /auth/identity-link/callback", "handleLinkCallback"]
]);

export function createBffHttpServer(handlers: BffRouteHandlers): Server {
  return createServer((request, response) => {
    applySecurityHeaders(response);
    void dispatch(request, response, handlers);
  });
}

async function dispatch(
  request: IncomingMessage,
  response: ServerResponse,
  handlers: BffRouteHandlers
): Promise<void> {
  const method = request.method?.toUpperCase() ?? "";
  let pathname: string;
  try {
    pathname = new URL(request.url ?? "/", "http://bff.invalid").pathname;
  } catch {
    sendError(response, 400, "bad_request");
    return;
  }

  const identityUnlinkPath = /^\\/account\\/identities\\/[0-9a-f-]{36}\\/unlink$/iu.test(pathname);
  const handlerName = ROUTES.get(`${method} ${pathname}`) ??
    (method === "POST" && identityUnlinkPath ? "unlinkIdentity" : undefined);
  if (!handlerName) {
    if (identityUnlinkPath) {
      response.setHeader("Allow", "POST");
      sendError(response, 405, "method_not_allowed");
      request.resume();
      return;
    }
    const allowed = [...ROUTES.entries()]
      .filter(([route]) => route.endsWith(` ${pathname}`))
      .map(([route]) => route.split(" ", 1)[0]);
    if (allowed.length > 0) {
      response.setHeader("Allow", [...new Set(allowed)].join(", "));
      sendError(response, 405, "method_not_allowed");
    } else {
      sendError(response, 404, "not_found");
    }
    request.resume();
    return;
  }

  if ((handlerName === "logout" || handlerName === "startReauth" || handlerName === "startUnlinkReauth" || handlerName === "startLink" || handlerName === "unlinkIdentity") &&
      ((request.headers["content-length"] !== undefined &&
        request.headers["content-length"] !== "0") ||
       request.headers["transfer-encoding"] !== undefined)) {
    sendError(response, 400, "bad_request");
    request.resume();
    return;
  }

  try {
    await handlers[handlerName](request, response);
    if (!response.writableEnded) {
      if (!response.headersSent) sendError(response, 500, "internal_error");
      else response.destroy();
    }
  } catch {
    if (!response.headersSent) {
      sendError(response, 500, "internal_error");
    } else if (!response.writableEnded) {
      response.destroy();
    }
  }
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Content-Security-Policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
}

function sendError(response: ServerResponse, status: number, error: string): void {
  if (response.writableEnded || response.headersSent) return;
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify({ error }));
}
