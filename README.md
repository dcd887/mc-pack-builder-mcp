# mc-pack-builder-mcp

[![M8ven Verified](https://m8ven.ai/badge/mcp/dcd887/mc-pack-builder-mcp?variant=verified)](https://m8ven.ai/mcp/dcd887/mc-pack-builder-mcp?s=readme)

MCP server for Minecraft modpack building. Creates pack structures, searches mods on Modrinth, resolves dependencies, checks compatibility, and exports standardized modpacks ready for distribution.

## Tools

| Tool | Description |
|------|-------------|
| `create_pack` | Create a new modpack directory structure (pack.mcmeta, version.txt, loader.txt, mods/) |
| `get_pack_info` | Read existing modpack metadata: MC version, loader, mod count, and common issues |
| `search_mods` | Search Modrinth for mods by keyword, returns ID, name, description, download count |
| `get_mod_info` | Get detailed info about a Modrinth mod: version history, dependencies, supported MC versions |
| `resolve_dependencies` | Recursively resolve a mod's full dependency chain (direct + indirect) |
| `check_pack_compatibility` | Check installed mods against a target MC version for known incompatibilities |
| `generate_dependency_list` | Generate a complete dependency list for all mods in an existing pack |
| `export_standard_pack` | Export a clean, distribution-ready modpack: cleanup extras, unwrap nested zips, generate modlist, optional volume splitting |

## Features

- **Pack structure creation** — generates standard modpack directory with all required files
- **Modrinth integration** — search and query mod metadata directly from the Modrinth API
- **Dependency resolution** — follows the full dependency tree to ensure all requirements are met
- **Compatibility checking** — detects known conflicts (e.g. OptiFine with Fabric, Sodium vs Embeddium)
- **Export standard pack** — automatically cleans .minecraft extras, unwraps nested zip bundles, generates a styled `modlist.html` or plain `modlist.txt`, and optionally splits large packs into ≤256 MB volumes for easy distribution
- **Offline operation** — all local pack tools work without network; only search/info tools need Modrinth

## Installation

### Prerequisites

- Node.js 18+
- npm

### Build

```bash
cd mc-pack-builder-mcp
npm install
npm run build
```

### Run as standalone MCP server

```bash
node dist/index.js
```

The server communicates via stdio (JSON-RPC 2.0). It can be consumed by any MCP-compatible client.

### Configuration for MCP clients

Add to your MCP client config:

```json
{
  "mcpServers": {
    "mc-pack-builder": {
      "command": "node",
      "args": ["${MC_PACK_BUILDER_ROOT}/dist/index.js"]
    }
  }
}
```

> **Path note:** Replace `${MC_PACK_BUILDER_ROOT}` with the absolute path to this project's root directory. On Windows, use forward slashes: `["C:/Users/xxx/Desktop/mc-pack-builder-mcp/dist/index.js"]`. Alternatively, set an environment variable `MC_PACK_BUILDER_ROOT` pointing to the project root and use the variable in the config.

## Configuration

本工具零配置即可用（内置默认值，任何环境开箱即用）。以下项目可通过环境变量或项目根目录 `.env` 文件覆盖（复制 `.env.example` 为 `.env`）：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PACK_BUILDER_MODRINTH_API_BASE` | `https://api.modrinth.com/v2` | Modrinth API 根地址，支持自建网关/代理 |
| `PACK_BUILDER_USER_AGENT` | `mc-pack-builder-mcp/1.1` | 请求 User-Agent（Modrinth 要求标明来源） |
| `PACK_BUILDER_VOLUME_MAX_MB` | `256` | 分卷导出时每卷的最大体积（MB） |
| `PACK_BUILDER_SKIP_DIRS` | `mods,config,resourcepacks,shaderpacks,saves,datapacks,worlds` | 解压嵌套压缩包时跳过的顶层目录（逗号分隔） |

优先级：环境变量 > `.env` 文件 > 内置默认值。改动后重启 MCP server 生效。

**扩展兼容性规则**：编辑 `src/pack-rules.json`（构建后为 `dist/pack-rules.json`），新增/覆盖规则即可，无需改代码。
- `rules.incompatible_pairs`：互斥模组对，如 `{ "mods": ["sodium", "embeddium"], "reason": "..." }`，当同一整合包同时出现 ≥2 个名单内模组时告警。
- `rules.loader_incompatible`：加载器专属不兼容，如 `{ "loader": "fabric", "mods": ["optifine"], "reason": "..." }`。
- `rules.pack_format`：MC 版本 → `pack.mcmeta` 的 `pack_format` 数字映射（`create_pack` 默认取值）。

## Usage Examples

### Create a new modpack

```json
{
  "name": "create_pack",
  "arguments": {
    "pack_dir": "/path/to/MyModpack",
    "name": "My Modpack",
    "mc_version": "1.20.1",
    "loader": "fabric"
  }
}
```

### Read pack info

```json
{
  "name": "get_pack_info",
  "arguments": {
    "pack_dir": "/path/to/MyModpack"
  }
}
```

### Search for a mod on Modrinth

```json
{
  "name": "search_mods",
  "arguments": {
    "query": "sodium",
    "limit": 5
  }
}
```

### Resolve dependencies

```json
{
  "name": "resolve_dependencies",
  "arguments": {
    "project_id": "geckolib"
  }
}
```

### Check pack compatibility

```json
{
  "name": "check_pack_compatibility",
  "arguments": {
    "pack_dir": "/path/to/MyModpack",
    "mc_version": "1.20.1"
  }
}
```

### Generate dependency list

```json
{
  "name": "generate_dependency_list",
  "arguments": {
    "pack_dir": "/path/to/MyModpack"
  }
}
```

### Export standard pack (release-ready)

```json
{
  "name": "export_standard_pack",
  "arguments": {
    "source_pack_dir": "C:/Users/xxx/Desktop/MyModpack",
    "output_dir": null,
    "clean_minecraft_extra": true,
    "minecraft_dir": "C:/Users/xxx/.minecraft",
    "unwrap_nested": true,
    "generate_modlist": true,
    "modlist_format": "html",
    "split_volumes": false,
    "volume_max_mb": 256
  }
}
```

**Output:** Creates a `_ready` sibling directory (or custom `output_dir`) with the cleaned package. Returns a JSON report listing all actions taken, warnings, mod count, and — if volume splitting is enabled — per-volume paths and sizes.

## Architecture

```
mc-pack-builder-mcp/
├── src/
│   ├── index.ts        # MCP server + all tool implementations
│   └── pack-rules.json # 兼容性规则 & pack_format 映射（可外部扩展）
├── dist/               # Compiled JavaScript (output of tsc)
├── __tests__/
│   └── unit.test.ts    # Unit tests (offline)
├── package.json        # Node.js dependencies (@modelcontextprotocol/sdk, zod, adm-zip)
├── tsconfig.json       # TypeScript config (CommonJS output)
├── test.js             # Integration test runner
├── test_logs/          # Test output logs (gitignored)
├── .env.example        # 环境变量配置示例
└── .gitignore
```

The MCP uses the official `@modelcontextprotocol/sdk` v1.x with `McpServer` and `StdioServerTransport`.

## Testing

```bash
npm run build
node test.js
```

Tests create temporary directories under `os.tmpdir()` and clean up after themselves. No Minecraft installation is required.

## Platform Compatibility

| Tool | Windows | macOS | Linux |
|------|---------|-------|-------|
| `create_pack` | ✅ | ✅ | ✅ |
| `get_pack_info` | ✅ | ✅ | ✅ |
| `search_mods` | ✅ | ✅ | ✅ |
| `get_mod_info` | ✅ | ✅ | ✅ |
| `resolve_dependencies` | ✅ | ✅ | ✅ |
| `check_pack_compatibility` | ✅ | ✅ | ✅ |
| `generate_dependency_list` | ✅ | ✅ | ✅ |
| `export_standard_pack` | ✅ | ✅ | ✅ |

All tools use cross-platform Node.js `fs` and `path` APIs. Network-dependent tools (`search_mods`, `get_mod_info`, `resolve_dependencies`) require internet access regardless of platform.

## License

MIT
