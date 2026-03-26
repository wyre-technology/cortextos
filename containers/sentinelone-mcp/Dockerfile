# Gateway-aware wrapper for SentinelOne Purple AI MCP server.
# Adds per-request credential injection via HTTP headers so the gateway
# can serve multiple tenants through a single container.
#
# Build:  docker build -t sentinelone-mcp-gateway .
# Run:    docker run -p 8080:8080 sentinelone-mcp-gateway

FROM ghcr.io/sentinel-one/purple-mcp:latest

# Copy our gateway middleware
COPY gateway_wrapper.py /app/gateway_wrapper.py

# Override port to match gateway convention (8080)
ENV MCP_MODE=streamable-http \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=8080 \
    PURPLEMCP_STATELESS_HTTP=true

EXPOSE 8080

# Run uvicorn with our wrapper app instead of the stock entrypoint
ENTRYPOINT ["python", "-m", "uvicorn", "gateway_wrapper:app", \
            "--host", "0.0.0.0", "--port", "8080", "--log-level", "info"]
