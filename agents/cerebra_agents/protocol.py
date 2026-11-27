"""Newline-delimited JSON-RPC 2.0 framing over stdio, plus the redacting logger.

stdout carries protocol messages only; everything else (logs, stray prints from libraries) goes to stderr,
through a filter that removes anything that looks like an API key and the exact keys of the current job.
"""

from __future__ import annotations

import json
import logging
import re
import sys
import threading
from collections.abc import Iterable
from typing import Any, TextIO

JSONRPC = "2.0"

# JSON-RPC error codes.
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603
BUSY = -32000

REDACTED = "[redacted]"

# Shapes of common API keys and bearer tokens. Deliberately broad: a false positive costs a log line,
# a false negative leaks a key.
_KEY_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"sk-[A-Za-z0-9_\-]{12,}"),  # OpenAI, Anthropic (sk-ant-…), DeepSeek, OpenRouter (sk-or-…)
    re.compile(r"gsk_[A-Za-z0-9]{12,}"),  # Groq
    re.compile(r"AIza[0-9A-Za-z_\-]{20,}"),  # Google
    re.compile(r"(?i)bearer\s+[A-Za-z0-9._\-~+/=]{8,}"),
    re.compile(r"(?i)(api[_-]?key|x-api-key|authorization|token|secret)([\"']?\s*[:=]\s*[\"']?)([^\s\"',}]{6,})"),
    re.compile(r"\b[A-Za-z0-9_\-]{40,}\b"),  # any long opaque token
)


class Redactor:
    """Removes key-like strings and registered secrets from text. Thread-safe."""

    def __init__(self) -> None:
        self._secrets: set[str] = set()
        self._lock = threading.Lock()

    def add(self, secrets: Iterable[str | None]) -> None:
        with self._lock:
            self._secrets.update(s for s in secrets if s and len(s) >= 4)

    def clear(self) -> None:
        with self._lock:
            self._secrets.clear()

    def __call__(self, text: str) -> str:
        with self._lock:
            secrets = sorted(self._secrets, key=len, reverse=True)
        for secret in secrets:
            text = text.replace(secret, REDACTED)
        for pattern in _KEY_PATTERNS:
            if pattern.groups == 3:
                text = pattern.sub(lambda m: f"{m.group(1)}{m.group(2)}{REDACTED}", text)
            else:
                text = pattern.sub(REDACTED, text)
        return text


redact = Redactor()


class RedactingFormatter(logging.Formatter):
    """Formats the record (including tracebacks) and then redacts the whole line."""

    def format(self, record: logging.LogRecord) -> str:
        return redact(super().format(record))


class RedactingFilter(logging.Filter):
    """Redacts the message early so other handlers attached later also see clean text."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:
            return True
        record.msg = redact(message)
        record.args = None
        return True


def setup_logging(stream: TextIO | None = None, level: int = logging.INFO) -> logging.Handler:
    """Send all logging to stderr (or `stream`) through the redactor. Returns the installed handler."""
    handler = logging.StreamHandler(stream or sys.stderr)
    handler.setFormatter(RedactingFormatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    handler.addFilter(RedactingFilter())
    root = logging.getLogger()
    for old in list(root.handlers):
        root.removeHandler(old)
    root.addHandler(handler)
    root.setLevel(level)
    for noisy in ("httpx", "httpcore", "openai", "anthropic", "google", "mcp", "strands"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    return handler


class Writer:
    """Writes one JSON object per line to the protocol stream. Safe to call from any thread."""

    def __init__(self, stream: TextIO) -> None:
        self._stream = stream
        self._lock = threading.Lock()

    def send(self, message: dict[str, Any]) -> None:
        line = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
        with self._lock:
            self._stream.write(line + "\n")
            self._stream.flush()

    def result(self, id_: Any, result: Any) -> None:
        self.send({"jsonrpc": JSONRPC, "id": id_, "result": result})

    def error(self, id_: Any, code: int, message: str, data: Any = None) -> None:
        err: dict[str, Any] = {"code": code, "message": redact(message)}
        if data is not None:
            err["data"] = data
        self.send({"jsonrpc": JSONRPC, "id": id_, "error": err})

    def notify(self, method: str, params: dict[str, Any]) -> None:
        self.send({"jsonrpc": JSONRPC, "method": method, "params": params})


class ProtocolError(Exception):
    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code


def parse_line(line: str) -> dict[str, Any]:
    """Parse one incoming line into a request/notification dict or raise ProtocolError."""
    try:
        msg = json.loads(line)
    except json.JSONDecodeError as e:
        raise ProtocolError(PARSE_ERROR, f"Parse error: {e.msg}") from None
    if not isinstance(msg, dict) or not isinstance(msg.get("method"), str):
        raise ProtocolError(INVALID_REQUEST, "Invalid request")
    params = msg.get("params", {})
    if params is None:
        params = {}
    if not isinstance(params, dict):
        raise ProtocolError(INVALID_PARAMS, "params must be an object")
    msg["params"] = params
    return msg
