# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | ✅                 |

## Security Considerations

This MCP server operates entirely on local filesystem paths. Network requests are limited to Modrinth API calls (`search_mods`, `get_mod_info`, `resolve_dependencies`) which use HTTPS exclusively.

### What this tool does NOT do
- ❌ Execute arbitrary shell commands
- ❌ Read or write files outside the provided paths
- ❌ Install or modify system packages
- ❌ Expose private keys or credentials

### Safe usage recommendations
- Always provide absolute paths to modpack directories you control
- Do not pass untrusted user input as `pack_dir` or `project_id` without basic validation
- Modrinth API calls use public HTTPS endpoints — no authentication required

## Reporting a Vulnerability

Please report security issues via the repository's [Security Advisories](../../advisories/new) page.
