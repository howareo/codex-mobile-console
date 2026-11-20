import hashlib
import json
import re
import sys
import tomllib


def digest(value):
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def key_path(parts):
    names = []
    for index, part in enumerate(parts):
        if (index == 1 and parts[0] in {"projects", "model_providers", "mcp_servers", "plugins"}) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", part):
            names.append("*")
        else:
            names.append(part)
    return ".".join(names)


def collect(value, parts, entries):
    if isinstance(value, dict):
        for name, child in value.items():
            collect(child, (*parts, name), entries)
    else:
        entries.setdefault(key_path(parts), []).append(digest(value))


with open(sys.argv[1], "rb") as config_file:
    config = tomllib.load(config_file)
entries = {}
collect(config, (), entries)
key_digests = {key: digest(sorted(values)) for key, values in sorted(entries.items())}
# Only known presentation preferences are irrelevant to the shared app-server.
desktop = config.get("desktop")
if isinstance(desktop, dict):
    for key in ("appearanceTheme", "codeFontSize", "sansFontSize", "localeOverride",
                "show-context-window-usage", "sidebar-show-projects-in-recents"):
        desktop.pop(key, None)
    if not desktop:
        config.pop("desktop")
# Codex Desktop rewrites this pipe directory on most launches (2026-11-10:
# 17 of 18 changes followed a Desktop start). A 4500 reload requires Desktop
# to be closed, so restarting can never catch up with it; it must not schedule
# one. Other MCP env/command changes stay detected.
servers = config.get("mcp_servers")
if isinstance(servers, dict):
    for server in servers.values():
        env = server.get("env") if isinstance(server, dict) else None
        if isinstance(env, dict):
            env.pop("SKY_CUA_NATIVE_PIPE_DIRECTORY", None)
# Files the config points at, at the root and under every profile (not only the
# active one), so the caller hashes exactly what app-server may load.
scopes = [config, *(p for p in config.get("profiles", {}).values() if isinstance(p, dict))]
referenced = sorted({scope[key] for scope in scopes
                     for key in ("model_catalog_json", "model_instructions_file", "experimental_compact_prompt_file")
                     if isinstance(scope.get(key), str)})
print(json.dumps({"keyDigests": key_digests, "runtimeSha256": digest(config), "referencedFiles": referenced}
                 if "--summary" in sys.argv[2:] else key_digests))
