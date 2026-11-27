"""AI sources: the provider table and provider → Strands model construction (doc 06 §2)."""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from strands.models import Model

PROVIDERS: tuple[str, ...] = (
    "gemini",
    "groq",
    "openrouter",
    "openai",
    "anthropic",
    "mistral",
    "deepseek",
    "openai_compatible",
    "ollama",
    "lmstudio",
)

# Human names used in plain-language messages.
DISPLAY_NAMES: dict[str, str] = {
    "gemini": "Gemini",
    "groq": "Groq",
    "openrouter": "OpenRouter",
    "openai": "OpenAI",
    "anthropic": "Anthropic",
    "mistral": "Mistral",
    "deepseek": "DeepSeek",
    "openai_compatible": "The AI server",
    "ollama": "Ollama",
    "lmstudio": "LM Studio",
}

# Default endpoints for providers that go through the OpenAI-compatible client (or Ollama's host).
DEFAULT_BASE_URLS: dict[str, str] = {
    "groq": "https://api.groq.com/openai/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "deepseek": "https://api.deepseek.com/v1",
    "lmstudio": "http://localhost:1234/v1",
    "ollama": "http://localhost:11434",
}

LOCAL_PROVIDERS = frozenset({"ollama", "lmstudio"})

# Per-call timeout (seconds) for remote providers; local models can be slow on first load.
REMOTE_TIMEOUT = 90.0
LOCAL_TIMEOUT = 300.0
MAX_OUTPUT_TOKENS = 4096


@dataclass(frozen=True)
class Caps:
    requests_per_day: int | None = None
    tokens_per_day: int | None = None


@dataclass
class Source:
    """One AI source as sent by the app in `run_job` / `test_source`. The key only ever lives here."""

    id: str
    provider: str
    model: str
    base_url: str | None = None
    api_key: str | None = field(default=None, repr=False)
    caps: Caps = field(default_factory=Caps)
    local: bool = False
    used_requests: int = 0
    used_tokens: int = 0

    @classmethod
    def from_json(cls, raw: dict[str, Any]) -> Source:
        if not isinstance(raw, dict):
            raise ValueError("source must be an object")
        provider = str(raw.get("provider") or "").strip().lower()
        if provider not in PROVIDERS:
            raise ValueError(f"unknown provider '{provider}'")
        model = str(raw.get("model") or "").strip()
        if not model:
            raise ValueError("source has no model")
        caps_raw = raw.get("caps") or {}
        used = raw.get("used_today") or {}
        return cls(
            id=str(raw.get("id") or provider),
            provider=provider,
            model=model,
            base_url=(raw.get("base_url") or None),
            api_key=(raw.get("api_key") or None),
            caps=Caps(
                requests_per_day=_opt_int(caps_raw.get("requests_per_day")),
                tokens_per_day=_opt_int(caps_raw.get("tokens_per_day")),
            ),
            local=bool(raw.get("local", provider in LOCAL_PROVIDERS)),
            used_requests=_opt_int(used.get("requests")) or 0,
            used_tokens=_opt_int(used.get("tokens")) or 0,
        )

    @property
    def name(self) -> str:
        return DISPLAY_NAMES.get(self.provider, self.provider)

    @property
    def label(self) -> str:
        """`provider:model`, as written into `made_by.source`."""
        return f"{self.provider}:{self.model}"

    @property
    def endpoint(self) -> str | None:
        return self.base_url or DEFAULT_BASE_URLS.get(self.provider)


def _opt_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


_SIZE_RE = re.compile(r"(?<![a-z0-9])(\d+(?:\.\d+)?)\s*b(?![a-z])", re.IGNORECASE)


def model_size_billions(model: str) -> float | None:
    """Parameter count parsed from a model name (`llama3.2:3b`, `qwen2.5-7b-instruct`), if present.

    Mixture-of-experts names like `8x7b` count the total.
    """
    name = model.lower()
    moe = re.search(r"(\d+)x(\d+(?:\.\d+)?)b(?![a-z])", name)
    if moe:
        return float(moe.group(1)) * float(moe.group(2))
    sizes = [float(m.group(1)) for m in _SIZE_RE.finditer(name)]
    return max(sizes) if sizes else None


def is_small(source: Source) -> bool:
    size = model_size_billions(source.model)
    return size is not None and size < 14


def wants_lite(sources: list[Source]) -> bool:
    """Lite mode when any source in the rotation is local or a small model (doc 06 §3).

    Any source can end up answering a call, so the prompts must suit the weakest one.
    """
    return any(s.local or is_small(s) for s in sources)


ModelFactory = Callable[[Source], Model]


def build_model(source: Source) -> Model:
    """Create the Strands model for a source. Network clients are created lazily by Strands."""
    p = source.provider
    timeout = LOCAL_TIMEOUT if source.local else REMOTE_TIMEOUT
    if p == "gemini":
        from strands.models.gemini import GeminiModel

        return GeminiModel(
            client_args={"api_key": source.api_key},
            model_id=source.model,
            params={"max_output_tokens": MAX_OUTPUT_TOKENS},
        )
    if p == "anthropic":
        from strands.models.anthropic import AnthropicModel

        return AnthropicModel(
            client_args={"api_key": source.api_key, "max_retries": 0, "timeout": timeout},
            model_id=source.model,
            max_tokens=MAX_OUTPUT_TOKENS,
        )
    if p == "mistral":
        from strands.models.mistral import MistralModel

        return MistralModel(api_key=source.api_key, model_id=source.model, max_tokens=MAX_OUTPUT_TOKENS)
    if p == "ollama":
        from strands.models.ollama import OllamaModel

        return OllamaModel(
            source.endpoint,
            ollama_client_args={"timeout": timeout},
            model_id=source.model,
            max_tokens=MAX_OUTPUT_TOKENS,
        )
    # Everything else speaks the OpenAI API.
    from strands.models.openai import OpenAIModel

    client_args: dict[str, Any] = {
        # Local servers ignore the key, but the client insists on one.
        "api_key": source.api_key or "not-needed",
        "max_retries": 0,
        "timeout": timeout,
    }
    if source.endpoint:
        client_args["base_url"] = source.endpoint
    return OpenAIModel(
        client_args=client_args,
        model_id=source.model,
        params={"max_tokens": MAX_OUTPUT_TOKENS},
    )


# -- When a provider retires a model ---------------------------------------------------------------------

# Models that can't chat (speech, safety filters, embeddings…) never replace a chat model.
_NOT_CHAT = (
    "whisper",
    "guard",
    "safeguard",
    "tts",
    "orpheus",
    "embed",
    "rerank",
    "moderation",
    "audio",
    "transcribe",
    "image",
    "dall-e",
    "aqa",
    "playai",
)
# Good general chat models, best first (matched as substrings, case-insensitive).
_PREFERRED = (
    "gpt-oss-120b",
    "llama-3.3-70b",
    "llama-4",
    "qwen3",
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini",
    "mistral-small",
    "mistral-medium",
    "deepseek-chat",
    "gpt-4.1-mini",
    "claude-haiku",
    "qwen",
    "llama",
    "gemma",
    "mistral",
    "gpt-oss-20b",
)


def pick_chat_model(available: list[str]) -> str | None:
    """The best chat model from a provider's current list, or None if there's no suitable one."""
    chat = [m for m in available if not any(x in m.lower() for x in _NOT_CHAT)]
    chat = [m for m in chat if (model_size_billions(m) or 99) >= 3]
    for want in _PREFERRED:
        for m in chat:
            if want in m.lower():
                return m
    return chat[0] if chat else None


def list_models(source: Source, timeout: float = 10.0) -> list[str]:
    """The provider's current model names (empty if it can't be asked). Never logs the key."""
    import json as _json
    import urllib.request

    key = source.api_key or ""
    ua = {"User-Agent": "cerebra-agents"}
    try:
        if source.provider == "gemini":
            url = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200"
            req = urllib.request.Request(url, headers={"x-goog-api-key": key, **ua})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = _json.load(r)
            return [
                m["name"].removeprefix("models/")
                for m in data.get("models", [])
                if "generateContent" in m.get("supportedGenerationMethods", [])
            ]
        if source.provider == "ollama":
            base = (source.endpoint or "http://localhost:11434").rstrip("/")
            with urllib.request.urlopen(f"{base}/api/tags", timeout=timeout) as r:
                return [m["name"] for m in _json.load(r).get("models", [])]
        base = source.endpoint
        if not base:
            base = {"openai": "https://api.openai.com/v1", "mistral": "https://api.mistral.ai/v1"}.get(source.provider)
        if not base:
            return []
        headers = {**ua, **({"Authorization": f"Bearer {key}"} if key else {})}
        req = urllib.request.Request(base.rstrip("/") + "/models", headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return [m["id"] for m in _json.load(r).get("data", []) if isinstance(m, dict) and "id" in m]
    except Exception:
        return []
