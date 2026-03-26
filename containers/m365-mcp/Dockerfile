FROM node:22-alpine
WORKDIR /app
RUN npm install -g @softeria/ms-365-mcp-server
EXPOSE 8080
ENV PORT=8080
CMD ["ms-365-mcp-server", "--http", "8080", "--org-mode"]
