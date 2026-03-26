"""Gateway-aware wrapper for the SentinelOne Purple AI MCP server.

Adds per-request credential injection to the stock Purple MCP server.
The gateway sends credentials via HTTP headers; this middleware extracts
them, sets the corresponding env vars, and clears the settings cache so
each request uses the correct tenant's credentials.

Headers read:
  X-S1-API-Token   → PURPLEMCP_CONSOLE_TOKEN
  X-S1-Console-URL → PURPLEMCP_CONSOLE_BASE_URL
"""

import asyncio
import os

from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp, Receive, Scope, Send

# Header → env var mapping
HEADER_MAP = {
    "x-s1-api-token": "PURPLEMCP_CONSOLE_TOKEN",
    "x-s1-console-url": "PURPLEMCP_CONSOLE_BASE_URL",
}

# Lock ensures env vars + cache clear are atomic per request
_request_lock = asyncio.Lock()


class GatewayAuthMiddleware:
    """ASGI middleware that injects per-request S1 credentials."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request = Request(scope)

        # Health endpoint doesn't need credentials
        if request.url.path == "/health":
            await self.app(scope, receive, send)
            return

        # Extract credentials from gateway-injected headers
        token = request.headers.get("x-s1-api-token")
        console_url = request.headers.get("x-s1-console-url")

        if not token or not console_url:
            response = JSONResponse(
                {"error": "Missing X-S1-API-Token or X-S1-Console-URL header"},
                status_code=401,
            )
            await response(scope, receive, send)
            return

        # Serialize credential injection — env vars are process-global
        async with _request_lock:
            os.environ["PURPLEMCP_CONSOLE_TOKEN"] = token
            os.environ["PURPLEMCP_CONSOLE_BASE_URL"] = console_url.rstrip("/")

            # Clear the settings lru_cache so get_settings() picks up new env vars
            from purple_mcp.config import get_settings

            get_settings.cache_clear()

            await self.app(scope, receive, send)


def create_app() -> ASGIApp:
    """Create the wrapped ASGI application."""
    # Force stateless mode and streamable-http transport
    os.environ.setdefault("PURPLEMCP_STATELESS_HTTP", "true")
    os.environ.setdefault("PURPLEMCP_TRANSPORT_MODE", "streamable-http")

    # Provide placeholder values so Settings validates at import time.
    # These get overwritten per-request by the middleware.
    os.environ.setdefault("PURPLEMCP_CONSOLE_TOKEN", "placeholder")
    os.environ.setdefault("PURPLEMCP_CONSOLE_BASE_URL", "https://placeholder.sentinelone.net")

    from purple_mcp.server import http_app

    return GatewayAuthMiddleware(http_app)


app = create_app()
