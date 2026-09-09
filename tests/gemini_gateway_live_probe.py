"""Mirror Bots/제미니봇/ask.js and probe the live /v1/ask endpoint.

This is an opt-in live diagnostic, not a pytest test. It never prints the
gateway Bearer key. Example:

    python tests/gemini_gateway_live_probe.py --key-file qwen_key "질문"
"""

from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
from typing import Any

import requests


BASE_URL = "http://192.168.0.55:18082/v1/ask"
CONNECT_TIMEOUT = 15
READ_TIMEOUT = 300
MODE = "auto"
SUMMARY_STYLE = "brief"
MAX_RESULTS = 3
LANGUAGE = "ko"


def _detail_to_text(detail: Any) -> str:
    if detail is None:
        return ""
    if isinstance(detail, str):
        return detail
    if isinstance(detail, list):
        parts: list[str] = []
        for item in detail[:3]:
            if not isinstance(item, dict):
                continue
            loc = item.get("loc") or []
            where = str(loc[-1]) if loc else ""
            message = str(item.get("msg") or "")
            parts.append((where + ": " if where else "") + message)
        return ", ".join(parts)
    return str(detail)


def _normalise_sources(values: Any) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    if not isinstance(values, list):
        return out
    for index, source in enumerate(values[:5]):
        if not isinstance(source, dict):
            continue
        url = str(
            source.get("final_url")
            or source.get("requested_url")
            or source.get("url")
            or ""
        ).strip()
        title = str(source.get("title") or "")
        if not re.fullmatch(r"https?://[^\s/?#]+(?:[/?#][^\s]*)?", url, re.IGNORECASE):
            continue
        out.append(
            {
                "id": str(source.get("source_id") or source.get("id") or f"S{index + 1}"),
                "title": title,
                "url": url,
            }
        )
    return out


def decode_gateway_response(
    status_code: int, payload: Any, raw: str, request_query: str
) -> dict[str, Any]:
    """Mirror ask.js decodeGatewayResponse, with extra live diagnostics."""
    if not 200 <= status_code < 300:
        server_error = payload.get("error") if isinstance(payload, dict) else None
        detail = _detail_to_text(payload.get("detail")) if isinstance(payload, dict) else raw[:160]
        if not detail and isinstance(server_error, dict):
            detail = str(server_error.get("message") or "")
        legacy_no_evidence = bool(
            re.search(
                r"(?:검색[^\r\n]{0,100}(?:출처|근거)|(?:출처|근거)[^\r\n]{0,100}(?:없|표시하지|누락))",
                detail,
                re.IGNORECASE,
            )
        )
        return {
            "ok": False,
            "http_status": status_code,
            "error": detail or f"HTTP {status_code}",
            "error_code": (
                str(server_error.get("code") or "")
                if isinstance(server_error, dict) and server_error.get("code")
                else ("SEARCH_NO_EVIDENCE" if legacy_no_evidence else "")
            ),
            "retryable": bool(server_error.get("retryable")) if isinstance(server_error, dict) else False,
            "connect_failed": False,
        }
    if not isinstance(payload, dict) or not isinstance(payload.get("answer"), str):
        return {"ok": False, "http_status": status_code, "error": "응답이 비어 있습니다."}

    answer = payload["answer"].strip()
    if not answer:
        return {"ok": False, "http_status": status_code, "error": "응답이 비어 있습니다."}
    sources = _normalise_sources(payload.get("sources"))
    route = str(payload.get("route") or "chat")
    is_search = route == "web_search" or bool(payload.get("searched")) or bool(payload.get("search"))
    search_meta = payload.get("search")
    zero_results = isinstance(search_meta, dict) and str(search_meta.get("results", "")).strip() == "0"
    no_results_answer = bool(
        re.fullmatch(
            r"(?:검색 결과를 찾지 못했습니다|검색 결과가 없습니다|No search results were found)[.!]?",
            answer,
            re.IGNORECASE,
        )
    )
    if is_search and (not sources or zero_results or no_results_answer):
        return {
            "ok": False,
            "http_status": status_code,
            "request_query": request_query,
            "error": "검색 근거를 확보하지 못했습니다. 질문 표현을 바꿔 다시 요청해 주세요.",
            "error_code": "SEARCH_NO_EVIDENCE",
            "connect_failed": False,
            "route": route,
            "searched": bool(payload.get("searched")),
            "source_count": len(sources),
            "search_meta": search_meta,
            "server_answer": answer,
            "elapsed_ms": payload.get("elapsed_ms") or 0,
        }

    return {
        "ok": True,
        "http_status": status_code,
        "request_query": request_query,
        "route": route,
        "route_reason": str(payload.get("route_reason") or ""),
        "answer": answer,
        "searched": bool(payload.get("searched")),
        "fallback_used": bool(payload.get("fallback_used")),
        "partial": bool(payload.get("partial")),
        "source_count": len(sources),
        "sources": sources,
        "elapsed_ms": payload.get("elapsed_ms") or 0,
        "search_meta": search_meta,
    }


def ask(query: str, bearer_key: str) -> dict[str, Any]:
    """Use the same request body and success criteria as ask.js."""
    normalised_query = re.sub(r"\s+", " ", str(query or "")).strip()
    body = {
        "query": normalised_query,
        "mode": MODE,
        "summary_style": SUMMARY_STYLE,
        "language": LANGUAGE,
        "max_results": MAX_RESULTS,
    }
    try:
        response = requests.post(
            BASE_URL,
            headers={
                "Authorization": f"Bearer {bearer_key}",
                "Content-Type": "application/json; charset=UTF-8",
            },
            json=body,
            timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
        )
    except requests.RequestException as exc:
        return {"ok": False, "connect_failed": True, "error": str(exc)}

    try:
        payload = response.json()
    except ValueError:
        payload = None

    return decode_gateway_response(
        response.status_code, payload, response.text, normalised_query
    )


def _read_key(path: str | None) -> str:
    if path:
        key = Path(path).read_text(encoding="utf-8").strip()
    else:
        key = os.environ.get("GATEWAY_API_KEY", "").strip()
    if not key or re.search(r"\s", key):
        raise SystemExit("유효한 --key-file 또는 GATEWAY_API_KEY가 필요합니다.")
    return key


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("queries", nargs="+")
    parser.add_argument("--key-file")
    args = parser.parse_args()
    key = _read_key(args.key_file)
    for query in args.queries:
        print(json.dumps(ask(query, key), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
